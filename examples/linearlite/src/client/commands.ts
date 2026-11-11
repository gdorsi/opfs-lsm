import { eq, queryOnce } from "@tanstack/db";
import { applyLocal, kanbanBetween } from "../domain/merge.ts";
import {
  commentKey,
  MUTABLE_FIELDS,
  type Body,
  type Comment,
  type Issue,
  type IssuePatch,
  type PriorityCode,
  type StatusCode,
} from "../domain/model.ts";
import { openStore, outboxKey, type OutboxMark, type Store } from "./store.ts";

let last = 0;
function tick(): number {
  last = Math.max(Date.now(), last + 1);
  return last;
}

const allDirty = (fields: readonly string[], clock: number) => Object.fromEntries(fields.map((f) => [f, clock]));

async function editIssue(id: string, patch: IssuePatch): Promise<void> {
  const { issues } = await openStore();
  const clock = tick();
  await issues.utils.transact([id], ([row]) => {
    if (row === undefined) return [undefined];
    const next = applyLocal(row, patch, clock);
    return [next === row ? undefined : { ...next, modified: clock }];
  });
}

function mark(store: Store, stream: OutboxMark["stream"], rowKey: string): Promise<void> {
  const id = outboxKey(stream, rowKey);
  return store.outbox.utils.transact([id], () => [{ id, stream, rowKey, nonce: crypto.randomUUID() }]);
}

export const setStatus = (id: string, status: StatusCode) => editIssue(id, { status });
export const setPriority = (id: string, priority: PriorityCode) => editIssue(id, { priority });
export const setTitle = (id: string, title: string) => editIssue(id, { title });
export const deleteIssue = (id: string) => editIssue(id, { deleted: true });

export const moveIssue = (id: string, status: StatusCode, before: string | null, after: string | null) =>
  editIssue(id, { status, kanbanorder: kanbanBetween(before, after) });

export async function setDescription(id: string, description: string): Promise<void> {
  const store = await openStore();
  const clock = tick();
  await mark(store, "bodies", id);
  await store.bodies.utils.transact([id], ([row]) => {
    const base: Body = row ?? { id, description: "", version: 0 };
    const next = applyLocal(base, { description }, clock);
    return [next === base ? undefined : next];
  });
}

export async function createIssue(input: { title: string; description: string; status: StatusCode; priority: PriorityCode }): Promise<string> {
  const store = await openStore();
  const id = crypto.randomUUID();
  const clock = tick();
  const [top] = await queryOnce((q) =>
    q
      .from({ i: store.issues })
      .where(({ i }) => eq(i.status, input.status))
      .orderBy(({ i }) => i.kanbanorder, "asc")
      .limit(1),
  );
  const issue: Issue = {
    id,
    title: input.title,
    status: input.status,
    priority: input.priority,
    kanbanorder: kanbanBetween(null, top?.kanbanorder ?? null),
    username: store.user,
    created: clock,
    modified: clock,
    deleted: false,
    version: 0,
    dirty: allDirty(MUTABLE_FIELDS.issues, clock),
  };
  const body: Body = { id, description: input.description, version: 0, dirty: { description: clock } };
  await mark(store, "bodies", id);
  await store.issues.utils.transact([id], () => [issue]);
  await store.bodies.utils.transact([id], () => [body]);
  return id;
}

export async function addComment(issueId: string, text: string): Promise<string> {
  const store = await openStore();
  const id = crypto.randomUUID();
  const clock = tick();
  const key = commentKey(issueId, id);
  const comment: Comment = {
    key,
    id,
    issue_id: issueId,
    body: text,
    username: store.user,
    created: clock,
    deleted: false,
    version: 0,
    dirty: allDirty(MUTABLE_FIELDS.comments, clock),
  };
  await mark(store, "comments", id);
  await store.comments.utils.transact([id], () => [comment]);
  return id;
}

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
/** Edit clocks only need to grow within a tab: an ack clears a field only when its clock matches the sent one. */
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

/** Written before the row, so a crash between the two leaves a mark on a clean row, which the leader drops. */
function mark(store: Store, stream: OutboxMark["stream"], rowKey: string): Promise<void> {
  const key = outboxKey(stream, rowKey);
  return store.outbox.utils.transact([key], () => [{ key, stream, rowKey, nonce: crypto.randomUUID() }]);
}

export const setStatus = (id: string, status: StatusCode) => editIssue(id, { status });
export const setPriority = (id: string, priority: PriorityCode) => editIssue(id, { priority });
export const setTitle = (id: string, title: string) => editIssue(id, { title });
export const deleteIssue = (id: string) => editIssue(id, { deleted: true });

/** Drop onto a board column between two neighbours' `kanbanorder` (null at either end). */
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

/** Creates the issue at the top of its board column, and its body. Returns the new id. */
export async function createIssue(input: { title: string; description: string; status: StatusCode; priority: PriorityCode }): Promise<string> {
  const store = await openStore();
  const id = crypto.randomUUID();
  const clock = tick();
  let first: string | null = null;
  for (const i of store.issues.values()) {
    if (i.status === input.status && (first === null || i.kanbanorder < first)) first = i.kanbanorder;
  }
  const issue: Issue = {
    id,
    title: input.title,
    status: input.status,
    priority: input.priority,
    kanbanorder: kanbanBetween(null, first),
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
  await mark(store, "comments", key);
  await store.comments.utils.transact([key], () => [comment]);
  return id;
}

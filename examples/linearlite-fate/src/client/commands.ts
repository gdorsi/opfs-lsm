import { kanbanBetween } from "../domain/kanban.ts";
import type { IssueFields, IssuePatch, PriorityCode, StatusCode } from "../domain/model.ts";
import { IssueRowView, openedFate, type Fate } from "./fate.ts";
import { onScreen, placeNewIssue } from "./screen.ts";

type Pending = Promise<{ error?: Error }> & { readonly locallyPersisted: Promise<void> };

/**
 * Resolves once the change is saved on the device and shown, which is what the UI waits for. The server's answer
 * comes later, maybe after a reload; a refusal rolls the change back, and is logged here and listed in the footer.
 */
function saved(what: string, pending: Pending): Promise<void> {
  pending.then(
    ({ error }) => error && console.warn(`linearlite: the server refused ${what}`, error),
    (err: unknown) => console.warn(`linearlite: ${what} failed`, err),
  );
  return pending.locallyPersisted;
}

type ListChanges = Pick<Parameters<Fate["mutations"]["updateIssue"]>[0], "insert" | "remove">;

function editIssue(id: string, patch: IssuePatch, lists: ListChanges = {}): Promise<void> {
  const { fate } = openedFate();
  return saved("an edit", fate.mutations.updateIssue({ input: { id, ...patch }, optimistic: { ...patch, modified: Date.now() }, ...lists }));
}

export const setStatus = (id: string, status: StatusCode) => editIssue(id, { status });
export const setPriority = (id: string, priority: PriorityCode) => editIssue(id, { priority });
export const setTitle = (id: string, title: string) => editIssue(id, { title });
export const setDescription = (id: string, description: string) => editIssue(id, { description });

export function deleteIssue(id: string): Promise<void> {
  return saved("a delete", openedFate().fate.mutations.deleteIssue({ input: { id }, delete: true }));
}

/** Moves a card between its new neighbours; a move to another column also leaves the old column's list and joins the new one. */
export function moveIssue(id: string, status: StatusCode, before: string | null, after: string | null): Promise<void> {
  const { fate } = openedFate();
  const from = (fate.store.read(`Issue:${id}`) as Partial<IssueFields> | undefined)?.status;
  const node = fate.ref("Issue", id, IssueRowView);
  const leave = from !== undefined && from !== status ? onScreen.columns.get(from)?.target : undefined;
  const join = from !== status ? onScreen.columns.get(status)?.target : undefined;
  return editIssue(
    id,
    { status, kanbanorder: kanbanBetween(before, after) },
    { ...(leave && { remove: { from: leave, node } }), ...(join && { insert: { into: join, position: "after" } }) },
  );
}

/**
 * Creates the issue at the top of its column and of the list when they are on screen and their filter lists it.
 * With its whole column on screen the client picks `kanbanorder` from the column's first card; otherwise the server
 * does, and under a filter the card sits above the first one on screen until the server answers.
 */
export async function createIssue(input: { title: string; description: string; status: StatusCode; priority: PriorityCode }): Promise<string> {
  const { fate, user } = openedFate();
  const id = crypto.randomUUID();
  const now = Date.now();
  const { into, shownOrder, sentOrder } = placeNewIssue(onScreen, input);
  await saved(
    "a new issue",
    fate.mutations.createIssue({
      input: { id, ...input, ...(sentOrder && { kanbanorder: sentOrder }) },
      optimistic: { id, ...input, ...(shownOrder && { kanbanorder: shownOrder }), username: user, created: now, modified: now },
      insert: into.map((target) => ({ into: target, position: "before" as const })),
    }),
  );
  return id;
}

export async function addComment(issueId: string, text: string): Promise<string> {
  const { fate, user } = openedFate();
  const id = crypto.randomUUID();
  const thread = onScreen.comments.get(issueId);
  await saved(
    "a comment",
    fate.mutations.addComment({
      input: { id, issueId, body: text },
      optimistic: { id, body: text, username: user, created: Date.now() },
      ...(thread && { insert: { into: thread, position: "after" } }),
    }),
  );
  return id;
}

import type { InsertionTarget, ViewRef } from "react-fate";
import { kanbanBetween } from "../domain/kanban.ts";
import type { IssuePatch, PriorityCode, StatusCode } from "../domain/model.ts";
import type { Fate } from "./fate.ts";
import type { NewIssuePlace } from "./place.ts";

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

function editIssue(fate: Fate, id: string, patch: IssuePatch, lists: ListChanges = {}): Promise<void> {
  return saved("an edit", fate.mutations.updateIssue({ input: { id, ...patch }, optimistic: { ...patch, modified: Date.now() }, ...lists }));
}

export const setStatus = (fate: Fate, id: string, status: StatusCode) => editIssue(fate, id, { status });
export const setPriority = (fate: Fate, id: string, priority: PriorityCode) => editIssue(fate, id, { priority });
export const setTitle = (fate: Fate, id: string, title: string) => editIssue(fate, id, { title });
export const setDescription = (fate: Fate, id: string, description: string) => editIssue(fate, id, { description });

export const deleteIssue = (fate: Fate, id: string): Promise<void> => saved("a delete", fate.mutations.deleteIssue({ input: { id }, delete: true }));

/** Moves a card between its new neighbours. A move to another column leaves `from`'s list and joins `to`'s. */
export function moveIssue(
  fate: Fate,
  card: ViewRef<"Issue">,
  move: { status: StatusCode; before: string | null; after: string | null; from?: InsertionTarget<"Issue">; to?: InsertionTarget<"Issue"> },
): Promise<void> {
  const { status, before, after, from, to } = move;
  return editIssue(
    fate,
    String(card.id),
    { status, kanbanorder: kanbanBetween(before, after) },
    { ...(from && { remove: { from, node: card } }), ...(to && { insert: { into: to, position: "after" } }) },
  );
}

export type IssueInput = { title: string; description: string; status: StatusCode; priority: PriorityCode };

/** Creates the issue on top of the lists `place` names; see `placeNewIssue`. */
export async function createIssue(fate: Fate, user: string, input: IssueInput, place: NewIssuePlace): Promise<string> {
  const id = crypto.randomUUID();
  const now = Date.now();
  const { into, shownOrder, sentOrder } = place;
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

/** Adds the comment at the end of `thread`, the issue's comment list as the screen read it. */
export async function addComment(fate: Fate, user: string, issueId: string, text: string, thread: InsertionTarget<"Comment"> | undefined): Promise<string> {
  const id = crypto.randomUUID();
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

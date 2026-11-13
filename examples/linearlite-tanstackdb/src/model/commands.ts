import { and, eq, queryOnce } from "@tanstack/db";
import { applyLocal, kanbanBetween, withDirty } from "../domain/merge.ts";
import {
  commentKey,
  type Body,
  type Comment,
  type Issue,
  type IssuePatch,
  type PriorityCode,
  type StatusCode,
} from "../domain/model.ts";
import { MUTABLE_FIELDS } from "../domain/stores.ts";
import { transact, type Store } from "./store.ts";

/** Local edits. Each is one write to kv, which the leader pushes. */
export interface Commands {
  createIssue(input: { title: string; description: string; status: StatusCode; priority: PriorityCode }): Promise<string>;
  setTitle(id: string, title: string): Promise<void>;
  setStatus(id: string, status: StatusCode): Promise<void>;
  setPriority(id: string, priority: PriorityCode): Promise<void>;
  /** A board drop: the status, and a board order between the neighbours. */
  moveIssue(id: string, status: StatusCode, before: string | null, after: string | null): Promise<void>;
  deleteIssue(id: string): Promise<void>;
  setDescription(id: string, description: string): Promise<void>;
  addComment(issueId: string, text: string): Promise<string>;
}

const allDirty = (fields: readonly string[], clock: number) => Object.fromEntries(fields.map((f) => [f, clock]));

/** `user` authors the issues and comments created here. */
export function commands(store: Store, user: string): Commands {
  let last = 0;
  const tick = () => {
    last = Math.max(Date.now(), last + 1);
    return last;
  };

  async function editIssue(id: string, patch: IssuePatch): Promise<void> {
    const clock = tick();
    await transact(store, "issues", [id], ([row]) => {
      if (row === undefined) return [undefined];
      const next = applyLocal(row, patch, clock);
      return [next === row ? undefined : { ...next, modified: clock }];
    });
  }

  return {
    setStatus: (id, status) => editIssue(id, { status }),
    setPriority: (id, priority) => editIssue(id, { priority }),
    setTitle: (id, title) => editIssue(id, { title }),
    deleteIssue: (id) => editIssue(id, { deleted: true }),
    moveIssue: (id, status, before, after) => editIssue(id, { status, kanbanorder: kanbanBetween(before, after) }),

    async setDescription(id, description) {
      const clock = tick();
      await store.bodies.utils.transact([id], ([row]) => {
        const base: Body = row ?? { id, description: "", version: 0 };
        const next = applyLocal(base, { description }, clock);
        return [next === base ? undefined : next];
      });
    },

    async createIssue(input) {
      const id = crypto.randomUUID();
      const clock = tick();
      const [top] = await queryOnce((q) =>
        q
          .from({ i: store.issues })
          .where(({ i }) => and(eq(i.deleted, false), eq(i.status, input.status)))
          .orderBy(({ i }) => i.statusOrder, "asc")
          .limit(1),
      );
      const issue = withDirty<Issue>(
        {
          id,
          title: input.title,
          status: input.status,
          priority: input.priority,
          kanbanorder: kanbanBetween(null, top?.kanbanorder ?? null),
          username: user,
          created: clock,
          modified: clock,
          deleted: false,
          version: 0,
        },
        allDirty(MUTABLE_FIELDS.issues, clock),
      );
      const body = withDirty<Body>({ id, description: input.description, version: 0 }, { description: clock });
      await transact(store, "issues", [id], () => [issue]);
      await store.bodies.utils.transact([id], () => [body]);
      return id;
    },

    async addComment(issueId, text) {
      const id = crypto.randomUUID();
      const clock = tick();
      const key = commentKey(issueId, id);
      const comment = withDirty<Comment>(
        { key, id, issue_id: issueId, body: text, username: user, created: clock, deleted: false, version: 0 },
        allDirty(MUTABLE_FIELDS.comments, clock),
      );
      await store.comments.utils.transact([id], () => [comment]);
      return id;
    },
  };
}

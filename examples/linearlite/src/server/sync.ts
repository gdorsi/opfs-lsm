import type { DatabaseSync } from "node:sqlite";
import { commentKey, MUTABLE_FIELDS, type ServerRow, type Stream } from "../domain/model.ts";
import { type DetailResponse, type PullResponse, type PushOp, type PushResponse, type PushResult, type RowResponse, WireError } from "../domain/wire.ts";
import { CODECS, readEpoch, readHead, statements, writeHead } from "./db.ts";

type Listener = (head: number) => void;
const LISTENERS = Symbol.for("linearlite.headListeners");
const listeners = (): Set<Listener> => ((globalThis as { [LISTENERS]?: Set<Listener> })[LISTENERS] ??= new Set());

export function onHead(listener: Listener): () => void {
  listeners().add(listener);
  return () => void listeners().delete(listener);
}

export function pull<S extends Stream>(db: DatabaseSync, stream: S, after: number, limit: number): PullResponse<S> {
  const st = statements(db).streams[stream];
  let raw = st.page.all(after, limit);
  let more = false;
  let last = after;
  if (raw.length === limit) {
    last = raw[limit - 1]!.version as number;
    raw = raw.filter((r) => (r.version as number) < last).concat(st.group.all(last));
    more = st.newer.get(last) !== undefined;
  }
  const head = readHead(db);
  return {
    rows: raw.map((r) => CODECS[stream].fromDb(r)),
    next: more ? last : head,
    head,
    more,
    epoch: readEpoch(db),
  };
}

export function detail(db: DatabaseSync, ids: readonly string[]): DetailResponse {
  const s = statements(db);
  return {
    bodies: ids.flatMap((id) => {
      const found = s.streams.bodies.get.get(id);
      return found ? [CODECS.bodies.fromDb(found)] : [];
    }),
    comments: ids.flatMap((id) => s.commentsOf.all(id)).map((r) => CODECS.comments.fromDb(r)),
  };
}

/** One row by id, tombstones included; `null` when the server has none. */
export function row<S extends Stream>(db: DatabaseSync, stream: S, id: string): RowResponse<S> {
  const found = statements(db).streams[stream].get.get(id);
  return { row: found ? CODECS[stream].fromDb(found) : null, epoch: readEpoch(db) };
}

interface Ctx {
  db: DatabaseSync;
  username: string;
  version: number;
  now: number;
}

const ORDER: Record<Stream, number> = { issues: 0, bodies: 1, comments: 2 };

export function push(db: DatabaseSync, ops: readonly PushOp[], username: string): PushResponse {
  const ordered = [...ops].sort((a, b) => ORDER[a.stream] - ORDER[b.stream]);
  const results: PushResult[] = [];
  let head = 0;
  let changed = false;
  db.exec("BEGIN IMMEDIATE");
  try {
    head = readHead(db);
    const ctx: Ctx = { db, username, version: head + 1, now: Date.now() };
    for (const op of ordered) {
      const { result, written } = applyOp(ctx, op);
      results.push(result);
      changed ||= written;
    }
    if (changed) writeHead(db, ++head);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  if (changed) for (const l of listeners()) l(head);
  return { results, head, epoch: readEpoch(db) };
}

function applyOp(ctx: Ctx, op: PushOp): { result: PushResult; written: boolean } {
  switch (op.stream) {
    case "issues": {
      const { row, written } = upsert(ctx, "issues", op.id, op.create, (old) => nextIssue(ctx, op.id, old, op.fields));
      return { result: { stream: "issues", id: op.id, clocks: op.clocks, row }, written };
    }
    case "bodies": {
      const { row, written } = upsert(ctx, "bodies", op.id, op.create, (old) => nextBody(ctx, op.id, old, op.fields));
      return { result: { stream: "bodies", id: op.id, clocks: op.clocks, row }, written };
    }
    case "comments": {
      const { row, written } = upsert(ctx, "comments", op.id, op.create, (old) => nextComment(ctx, op.id, old, op.fields));
      return { result: { stream: "comments", id: op.id, clocks: op.clocks, row }, written };
    }
  }
}

function upsert<S extends Stream>(
  { db }: Ctx,
  stream: S,
  id: string,
  create: true | undefined,
  next: (old: ServerRow<S> | undefined) => ServerRow<S>,
): { row: ServerRow<S>; written: boolean } {
  const st = statements(db).streams[stream];
  const codec = CODECS[stream];
  const found = st.get.get(id);
  const old = found ? codec.fromDb(found) : undefined;
  if (!old && !create) throw new WireError(`${stream}/${id} does not exist; send it with create`, 409);
  const row = next(old);
  if (row === old) return { row, written: false };
  const params = codec.params(row);
  if (old) st.update.run(...params.slice(1), id);
  else st.insert.run(...params);
  return { row, written: true };
}

function sameFields<T>(a: T, b: T, keys: readonly (keyof T)[]): boolean {
  return keys.every((k) => a[k] === b[k]);
}

const requireIssue = (db: DatabaseSync, issueId: string) => {
  if (statements(db).issueExists.get(issueId) === undefined) throw new WireError(`issue ${issueId} does not exist`, 409);
};

function nextIssue(ctx: Ctx, id: string, old: ServerRow<"issues"> | undefined, f: Extract<PushOp, { stream: "issues" }>["fields"]) {
  if (!old) {
    if (f.title === undefined || f.status === undefined || f.priority === undefined || f.kanbanorder === undefined) {
      throw new WireError("creating an issue needs title, status, priority and kanbanorder");
    }
    return { id, title: f.title, status: f.status, priority: f.priority, kanbanorder: f.kanbanorder, username: ctx.username, created: ctx.now, modified: ctx.now, deleted: f.deleted ?? false, version: ctx.version };
  }
  const merged = { ...old, ...f };
  if (sameFields(merged, old, MUTABLE_FIELDS.issues)) return old;
  return { ...merged, modified: ctx.now, version: ctx.version };
}

function nextBody(ctx: Ctx, id: string, old: ServerRow<"bodies"> | undefined, f: Extract<PushOp, { stream: "bodies" }>["fields"]) {
  if (!old) {
    if (f.description === undefined) throw new WireError("creating a body needs description");
    requireIssue(ctx.db, id);
    return { id, description: f.description, version: ctx.version };
  }
  if (f.description === undefined || f.description === old.description) return old;
  return { ...old, description: f.description, version: ctx.version };
}

function nextComment(ctx: Ctx, id: string, old: ServerRow<"comments"> | undefined, f: Extract<PushOp, { stream: "comments" }>["fields"]) {
  if (!old) {
    if (f.body === undefined || f.issue_id === undefined) throw new WireError("creating a comment needs issue_id and body");
    requireIssue(ctx.db, f.issue_id);
    return { key: commentKey(f.issue_id, id), id, issue_id: f.issue_id, body: f.body, username: ctx.username, created: ctx.now, deleted: f.deleted ?? false, version: ctx.version };
  }
  if (f.issue_id !== undefined && f.issue_id !== old.issue_id) throw new WireError("a comment's issue_id cannot change", 409);
  const { issue_id: _issueId, ...fields } = f;
  const merged = { ...old, ...fields };
  if (sameFields(merged, old, MUTABLE_FIELDS.comments)) return old;
  return { ...merged, version: ctx.version };
}

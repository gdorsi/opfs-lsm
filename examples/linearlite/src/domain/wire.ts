import {
  type BodyPatch,
  type Clocks,
  type CommentPatch,
  type IssuePatch,
  type PriorityCode,
  type ServerRow,
  type StatusCode,
  STREAMS,
  type Stream,
} from "./model.ts";

/** A request the server refuses. `status` is the HTTP status the route answers with. */
export class WireError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "WireError";
    this.status = status;
  }
}

export type OpFields = {
  issues: IssuePatch;
  bodies: BodyPatch;
  /** `issue_id` is read only when the comment is created. */
  comments: CommentPatch & { issue_id?: string };
};
export type PushOp = { [S in Stream]: { stream: S; id: string; fields: OpFields[S]; clocks: Clocks; create?: true } }[Stream];
export type PushResult = { [S in Stream]: { stream: S; id: string; clocks: Clocks; row: ServerRow<S> } }[Stream];

export interface PullRequest {
  stream: Stream;
  after: number;
  limit: number;
}
export interface PullResponse<S extends Stream = Stream> {
  rows: ServerRow<S>[];
  /** The cursor to ask with next: the last row's version, or `head` once `more` is false. */
  next: number;
  head: number;
  more: boolean;
  epoch: string;
}
export interface PushRequest {
  ops: PushOp[];
}
export interface PushResponse {
  results: PushResult[];
  head: number;
  epoch: string;
}
export interface DetailResponse {
  body: ServerRow<"bodies"> | null;
  comments: ServerRow<"comments">[];
}

export const MAX_OPS = 1000;
export const MAX_PULL_LIMIT = 10_000;
export const DEFAULT_PULL_LIMIT = 1000;
const MAX_TITLE = 500;
const MAX_DESCRIPTION = 200_000;
const MAX_COMMENT = 50_000;

const fail = (message: string): never => {
  throw new WireError(message);
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function id(v: unknown, what: string): string {
  if (typeof v !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(v)) return fail(`${what} must be 1-64 characters of [A-Za-z0-9_-]`);
  return v;
}
function text(max: number, min = 0) {
  return (v: unknown, what: string): string => {
    if (typeof v !== "string" || v.length < min || v.length > max) return fail(`${what} must be a string of ${min}-${max} characters`);
    return v;
  };
}
function code(v: unknown, what: string): StatusCode & PriorityCode {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 4) return fail(`${what} must be an integer 0-4`);
  return v as StatusCode & PriorityCode;
}
function bool(v: unknown, what: string): boolean {
  return typeof v === "boolean" ? v : fail(`${what} must be a boolean`);
}
function kanbanorder(v: unknown, what: string): string {
  if (typeof v !== "string" || !/^[0-9A-Za-z]{1,64}$/.test(v)) return fail(`${what} must be 1-64 alphanumeric characters`);
  return v;
}
function integer(v: unknown, what: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) return fail(`${what} must be an integer ${min}-${max}`);
  return v;
}

type FieldParser = (v: unknown, what: string) => unknown;
const FIELD_PARSERS: Record<Stream, Record<string, FieldParser>> = {
  issues: { title: text(MAX_TITLE, 1), status: code, priority: code, kanbanorder, deleted: bool },
  bodies: { description: text(MAX_DESCRIPTION) },
  comments: { body: text(MAX_COMMENT, 1), deleted: bool, issue_id: id },
};

function parseFields<S extends Stream>(stream: S, raw: unknown): OpFields[S] {
  if (!isRecord(raw)) return fail("fields must be an object");
  const parsers = FIELD_PARSERS[stream];
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(raw)) {
    const parse = Object.hasOwn(parsers, name) ? parsers[name] : undefined;
    if (!parse) return fail(`${stream}: unknown field "${name}"`);
    out[name] = parse(value, name);
  }
  if (Object.keys(out).length === 0) return fail("fields must not be empty");
  return out as OpFields[S];
}

function parseClocks(raw: unknown, fields: object): Clocks {
  if (!isRecord(raw)) return fail("clocks must be an object");
  const out: Record<string, number> = {};
  for (const [name, clock] of Object.entries(raw)) {
    if (!Object.hasOwn(fields, name)) return fail(`clock for "${name}" has no field`);
    if (typeof clock !== "number" || !Number.isFinite(clock) || clock < 0) return fail(`clock for "${name}" must be a non-negative number`);
    out[name] = clock;
  }
  return out;
}

function parseOp(raw: unknown): PushOp {
  if (!isRecord(raw)) return fail("op must be an object");
  const stream = parseStream(raw.stream);
  const fields = parseFields(stream, raw.fields);
  const create = raw.create === undefined || raw.create === false ? undefined : raw.create === true ? true : fail("create must be true");
  return {
    stream,
    id: id(raw.id, "id"),
    fields,
    clocks: parseClocks(raw.clocks ?? {}, fields),
    ...(create && { create }),
  } as PushOp;
}

function parseStream(v: unknown): Stream {
  return STREAMS.find((s) => s === v) ?? fail(`stream must be one of ${STREAMS.join(", ")}`);
}

function parseInt10(v: string | null, what: string, fallback: number, min: number, max: number): number {
  if (v === null) return fallback;
  return /^\d{1,15}$/.test(v) ? integer(Number(v), what, min, max) : fail(`${what} must be an integer ${min}-${max}`);
}

export function parsePullRequest(params: URLSearchParams): PullRequest {
  return {
    stream: parseStream(params.get("stream")),
    after: parseInt10(params.get("after"), "after", 0, 0, Number.MAX_SAFE_INTEGER),
    limit: parseInt10(params.get("limit"), "limit", DEFAULT_PULL_LIMIT, 1, MAX_PULL_LIMIT),
  };
}

export function parsePushRequest(json: unknown): PushRequest {
  if (!isRecord(json) || !Array.isArray(json.ops)) return fail("body must be { ops: [...] }");
  if (json.ops.length > MAX_OPS) return fail(`at most ${MAX_OPS} ops per push`);
  return { ops: json.ops.map(parseOp) };
}

export function parseDetailRequest(params: URLSearchParams): { id: string } {
  return { id: id(params.get("id"), "id") };
}

/** The pushing user's name, from the `x-linearlite-user` header. There is no login; absent means "anonymous". */
export function parseUsername(header: string | null): string {
  if (header === null) return "anonymous";
  return /^[A-Za-z0-9._-]{1,32}$/.test(header) ? header : fail("x-linearlite-user must be 1-32 characters of [A-Za-z0-9._-]");
}

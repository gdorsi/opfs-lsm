import type { Clocks, Rows, ServerRow } from "./model.ts";
import { fail, id } from "./parse.ts";
import { type FieldsWith, STREAMS, type Stream, streamOf } from "./stores.ts";

export type OpFields = { [S in Stream]: Partial<Pick<Rows[S], Extract<FieldsWith<S, "parse">, keyof Rows[S]>>> };
export type PushOp = { [S in Stream]: { stream: S; id: string; fields: OpFields[S]; clocks: Clocks; create?: true } }[Stream];
export type PushResult = { [S in Stream]: { stream: S; id: string; clocks: Clocks; row: ServerRow<S> } }[Stream];

export interface PullRequest {
  stream: Stream;
  after: number;
  limit: number;
}
export interface PullResponse<S extends Stream = Stream> {
  rows: ServerRow<S>[];
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
/** The bodies the server holds for the asked issues (an issue without one adds none) and all their comments. */
export interface DetailResponse {
  bodies: ServerRow<"bodies">[];
  comments: ServerRow<"comments">[];
}

export interface RowResponse<S extends Stream = Stream> {
  row: ServerRow<S> | null;
  epoch: string;
}

export const MAX_OPS = 1000;
export const MAX_DETAIL_IDS = 100;
const MAX_PULL_LIMIT = 10_000;
const DEFAULT_PULL_LIMIT = 1000;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function integer(v: unknown, what: string, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) return fail(`${what} must be an integer ${min}-${max}`);
  return v;
}

function parseFields<S extends Stream>(stream: S, raw: unknown): OpFields[S] {
  if (!isRecord(raw)) return fail("fields must be an object");
  const parsers = streamOf(stream).fields;
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(raw)) {
    const parse = Object.hasOwn(parsers, name) ? parsers[name]?.parse : undefined;
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

/** `id` repeats, once per issue. */
export function parseDetailRequest(params: URLSearchParams): { ids: string[] } {
  const ids = [...new Set(params.getAll("id"))];
  if (ids.length === 0 || ids.length > MAX_DETAIL_IDS) return fail(`id must be given 1-${MAX_DETAIL_IDS} times`);
  return { ids: ids.map((v) => id(v, "id")) };
}

/** `id` is the comment's own id for the comments stream, not its `key`. */
export function parseRowRequest(params: URLSearchParams): { stream: Stream; id: string } {
  return { stream: parseStream(params.get("stream")), id: id(params.get("id"), "id") };
}

export function parseUsername(header: string | null): string {
  if (header === null) return "anonymous";
  return /^[A-Za-z0-9._-]{1,32}$/.test(header) ? header : fail("x-linearlite-user must be 1-32 characters of [A-Za-z0-9._-]");
}

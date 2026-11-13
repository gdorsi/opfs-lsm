import type { IndexDecl } from "@opfs-lsm/docstore";
import { type Body, type Clean, commentKey, type Comment, type Issue, type StoredIssue, type Synced } from "./model.ts";
import { bool, code, id, kanbanorder, type Parse, text } from "./parse.ts";

const MAX_TITLE = 500;
const MAX_DESCRIPTION = 200_000;
const MAX_COMMENT = 50_000;

type Field<V> = {
  /** The server column's type. A `bool` is stored as 0 or 1. */
  readonly sql: "text" | "int" | "bool";
  /** A push may carry the field. A field without it is server-owned. */
  readonly parse?: Parse<V>;
  /** A local edit may change it, and the push of a new row sends it. */
  readonly mutable?: true;
  /** The name of the server index on the column. Every table is also indexed on `version`. */
  readonly indexed?: string;
  /** On create, the value when the push leaves the field out. A field a push may carry and has no default is required on create. */
  readonly default?: V;
  /** The server sets it on create: `author` to the pushing user, `created` and `modified` to now. `modified` is set again on every change. */
  readonly stamp?: "author" | "created" | "modified";
  /** The field holds the id of an issue, which must exist when the row is created. */
  readonly ref?: "issues";
};

type StreamSpec<Stored extends { id: string }, Row extends Synced & { id: string }, Derived extends keyof Row = never> = {
  readonly load: "eager" | "on-demand";
  /** `full`: pulled from version 0. `threads`: pulled from the head on, for the issues whose thread the replica holds. */
  readonly pull: "full" | "threads";
  readonly indexes: { readonly [name: string]: IndexDecl<Stored> };
  readonly table: string;
  /** One entry per server column, in column order, `id` first. */
  readonly fields: { readonly [F in Exclude<keyof Clean<Row>, Derived>]-?: Field<Row[F & keyof Row]> };
  /** The fields a row gets on the way out of the server database, from its columns. */
  readonly derive?: (columns: Omit<Clean<Row>, Derived>) => Pick<Row, Derived>;
};

const stream =
  <Stored extends { id: string }, Row extends Synced & { id: string }, Derived extends keyof Row = never>() =>
  <const S extends StreamSpec<Stored, Row, Derived>>(spec: S): S =>
    spec;

/**
 * The stores of the replica, and for each stream (a store the server holds) how it loads, pulls, indexes and
 * validates. A push applies streams in this order, so a stream lists after the one its rows belong to.
 */
export const STORES = {
  issues: stream<StoredIssue, Issue>()({
    load: "on-demand",
    pull: "full",
    indexes: {
      byCreated: { on: ["deleted", "created"] },
      byTitle: { on: ["deleted", "title"] },
      byPriority: { on: ["deleted", "priority", "priorityOrder"] },
      byStatus: { on: ["deleted", "status", "statusOrder"] },
      search: { on: ["deleted", "modified"], text: "title" },
      pending: { on: "pending" },
    },
    table: "issue",
    fields: {
      id: { sql: "text" },
      title: { sql: "text", parse: text(MAX_TITLE, 1), mutable: true },
      status: { sql: "int", parse: code, mutable: true },
      priority: { sql: "int", parse: code, mutable: true },
      kanbanorder: { sql: "text", parse: kanbanorder, mutable: true },
      username: { sql: "text", stamp: "author" },
      created: { sql: "int", stamp: "created" },
      modified: { sql: "int", stamp: "modified" },
      deleted: { sql: "bool", parse: bool, mutable: true, default: false },
      version: { sql: "int" },
    },
  }),
  bodies: stream<Body, Body>()({
    load: "on-demand",
    pull: "threads",
    indexes: { pending: { on: "pending" } },
    table: "body",
    fields: {
      id: { sql: "text", ref: "issues" },
      description: { sql: "text", parse: text(MAX_DESCRIPTION), mutable: true },
      version: { sql: "int" },
    },
  }),
  comments: stream<Comment, Comment, "key">()({
    load: "on-demand",
    pull: "threads",
    indexes: { byIssue: { on: "issue_id" }, pending: { on: "pending" } },
    table: "comment",
    fields: {
      id: { sql: "text" },
      issue_id: { sql: "text", parse: id, indexed: "comment_issue", ref: "issues" },
      body: { sql: "text", parse: text(MAX_COMMENT, 1), mutable: true },
      username: { sql: "text", stamp: "author" },
      created: { sql: "int", stamp: "created" },
      deleted: { sql: "bool", parse: bool, mutable: true, default: false },
      version: { sql: "int" },
    },
    derive: (c) => ({ key: commentKey(c.issue_id, c.id) }),
  }),
  sync: { load: "eager", indexes: {} },
} as const;

export type Stream = { [N in keyof typeof STORES]: (typeof STORES)[N] extends { readonly pull: string } ? N : never }[keyof typeof STORES];

const isStream = (name: string): name is Stream => "pull" in STORES[name as keyof typeof STORES];
export const STREAMS: readonly Stream[] = Object.keys(STORES).filter(isStream);

type FieldsOf<S extends Stream> = (typeof STORES)[S]["fields"];
/** The fields of stream `S` that carry `K`: `parse` (a push may carry them) or `mutable` (a local edit may change them). */
export type FieldsWith<S extends Stream, K extends "parse" | "mutable"> = {
  [F in keyof FieldsOf<S>]: FieldsOf<S>[F] extends { readonly [P in K]: unknown } ? F : never;
}[keyof FieldsOf<S>];

/** A stream's spec for code that loops over every stream. */
type AnyStream = {
  readonly table: string;
  readonly fields: Readonly<Record<string, Field<unknown>>>;
  readonly derive?: (columns: never) => object;
};
export const streamOf = (s: Stream): AnyStream => STORES[s];

export const MUTABLE_FIELDS = Object.fromEntries(
  STREAMS.map((s) => [s, Object.entries(streamOf(s).fields).flatMap(([name, f]) => (f.mutable ? [name] : []))]),
) as unknown as { readonly [S in Stream]: readonly FieldsWith<S, "mutable">[] };

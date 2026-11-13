import type { DatabaseSync } from "node:sqlite";
import { createMutationIdempotency, type IdempotencyStore, type MutationReceipt } from "@nkzw/fate/persistence/server";
import {
  createFateServer,
  dataView,
  FateRequestError,
  list,
  resolveSourceByIds,
  type SourceDefinition,
  type SourceRegistry,
} from "@nkzw/fate/server";
import { z } from "zod";
import { SORT_FIELDS } from "../client/filter.ts";
import { isKanbanOrder, kanbanBetween } from "../domain/kanban.ts";
import { PERSISTENCE_KEY, type CommentEntity, type IssueEntity, type IssuePatch, type NewComment, type NewIssue } from "../domain/model.ts";
import { columnTop, countByStatus, deleteIssue, insertComment, insertIssue, readColumn, readComments, readIssues, readWindow, updateIssue, type Page } from "./issues.ts";

type Context = { readonly db: DatabaseSync; readonly user: string };

const commentData = dataView<CommentEntity>("Comment")({ id: true, body: true, username: true, created: true });
const issueData = dataView<IssueEntity>("Issue")({
  id: true,
  title: true,
  status: true,
  priority: true,
  kanbanorder: true,
  username: true,
  created: true,
  modified: true,
  description: true,
  comments: list(commentData),
});

const issueSource: SourceDefinition<IssueEntity> = { id: "id", view: issueData };
const commentSource: SourceDefinition<CommentEntity> = { id: "id", view: commentData };
/** By type name: `list(view)` copies the view, so the views fate passes are not the ones declared here. */
const SOURCES = new Map<string, SourceDefinition<any>>([
  ["Issue", issueSource],
  ["Comment", commentSource],
]);

const registry: SourceRegistry<Context> = new Map([
  [
    issueSource,
    {
      byIds: async ({ ctx, ids, plan }) => {
        const paths = [...plan.selectedPaths];
        return readIssues(ctx.db, ids, { description: paths.includes("description"), comments: paths.some((p) => p.startsWith("comments")) });
      },
    },
  ],
  [commentSource, { byIds: async ({ ctx, ids }) => readComments(ctx.db, ids) }],
] as [SourceDefinition<any>, SourceRegistry<Context> extends Map<any, infer E> ? E : never][]);

const code = z.literal([0, 1, 2, 3, 4]);
const codes = z.array(code).max(5);
const q = z.string().max(200);
const filterArgs = z.object({ status: codes, priority: codes, q });
const windowArgs = filterArgs.extend({
  sort: z.enum(SORT_FIELDS),
  dir: z.enum(["asc", "desc"]),
  offset: z.number().int().min(0),
  limit: z.number().int().min(1).max(500),
});
const columnArgs = z.object({ column: code, priority: codes, q, first: z.number().int().min(1).max(500), after: z.string().nullish() });
const cursor = z.tuple([z.string(), z.string()]);

const title = z.string().trim().min(1).max(500);
const description = z.string().max(100_000);
/** Checked because a stored order becomes a neighbour: one bad value would make every later create in its column throw. */
const kanbanorder = z.string().max(200).refine(isKanbanOrder);
const updateInput: z.ZodType<IssuePatch & { id: string }> = z.object({ id: z.string(), title, status: code, priority: code, kanbanorder, description }).partial().required({ id: true });
const createInput: z.ZodType<NewIssue> = z.object({ id: z.uuid(), title, description, status: code, priority: code, kanbanorder: kanbanorder.optional() });
const deleteInput = z.object({ id: z.string() });
const commentInput: z.ZodType<NewComment> = z.object({ id: z.uuid(), issueId: z.string(), body: z.string().trim().min(1).max(20_000) });

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value ?? {});
  if (!result.success) throw new FateRequestError("BAD_REQUEST", "Invalid arguments.", { issues: result.error.issues });
  return result.data;
}

const toConnection = (page: Page, cursorOf: (row: Page["rows"][number]) => string, hasPrevious: boolean) => ({
  items: page.rows.map((row) => ({ cursor: cursorOf(row), node: { __typename: "Issue" as const, ...row } })),
  pagination: { hasNext: page.more, hasPrevious, nextCursor: page.rows.length > 0 ? cursorOf(page.rows.at(-1)!) : undefined },
});

async function selectedIssue(ctx: Context, id: string, select: string[]) {
  const [issue] = await resolveSourceByIds({ ctx, ids: [id], input: { select }, registry, source: issueSource });
  if (!issue) throw new FateRequestError("NOT_FOUND", `No issue ${id}.`);
  return issue as IssueEntity;
}

/** Receipts and the mutation's writes commit in one SQLite transaction. Requests run one at a time (`handleRequest`). */
const receipts: IdempotencyStore<Context> = {
  async transaction(context, scope, id, run) {
    const { db } = context;
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = await run({
        context,
        read: async () => {
          const row = db.prepare("SELECT value FROM receipt WHERE scope = ? AND id = ?").get(scope, id);
          return row ? (JSON.parse(row.value as string) as MutationReceipt) : undefined;
        },
        write: async (receipt) => {
          db.prepare("INSERT INTO receipt (scope, id, value) VALUES (?, ?, ?)").run(scope, id, JSON.stringify(receipt));
        },
      });
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  },
};

const USER = /^[A-Za-z0-9._-]{1,32}$/;

export function createServer(db: DatabaseSync) {
  const server = createFateServer({
    context: ({ request }): Context => {
      const user = request.headers.get("x-linearlite-user");
      return { db, user: user !== null && USER.test(user) ? user : "anonymous" };
    },
    idempotency: createMutationIdempotency({ scope: () => PERSISTENCE_KEY, store: receipts }),
    roots: { issues: list(issueData) },
    sources: { getSource: (target) => ("view" in target ? target : SOURCES.get(target.typeName)!), registry },
    lists: {
      issues: {
        type: "Issue",
        resolve: ({ ctx, input }: { ctx: Context; input: { args?: unknown } }) => {
          const args = parse(windowArgs, input.args);
          // fate reads `hasPrevious` as "rows before this list are missing" and then does not count the list as cached,
          // so a window, which is complete as its own request, never reports it.
          return toConnection(readWindow(ctx.db, args), (row) => row.id, false);
        },
      },
      column: {
        type: "Issue",
        resolve: ({ ctx, input }: { ctx: Context; input: { args?: unknown } }) => {
          const { after, ...args } = parse(columnArgs, input.args);
          const from = after ? parse(cursor, (() => { try { return JSON.parse(after); } catch { return null; } })()) : undefined;
          return toConnection(readColumn(ctx.db, args, from), (row) => JSON.stringify([row.kanbanorder, row.id]), from !== undefined);
        },
      },
    },
    queries: {
      counts: { resolve: ({ ctx, input }: { ctx: Context; input: { args?: unknown } }) => countByStatus(ctx.db, parse(filterArgs, input.args)) },
    },
    mutations: {
      updateIssue: {
        input: updateInput,
        type: "Issue",
        resolve: async ({ ctx, input, select }: { ctx: Context; input: IssuePatch & { id: string }; select: string[] }) => {
          const { id, ...patch } = input;
          if (!updateIssue(ctx.db, id, patch, Date.now())) throw new FateRequestError("NOT_FOUND", `No issue ${id}.`);
          return selectedIssue(ctx, id, select);
        },
      },
      createIssue: {
        input: createInput,
        type: "Issue",
        resolve: async ({ ctx, input, select }: { ctx: Context; input: NewIssue; select: string[] }) => {
          const now = Date.now();
          const order = input.kanbanorder ?? kanbanBetween(null, columnTop(ctx.db, input.status));
          insertIssue(ctx.db, { ...input, kanbanorder: order, username: ctx.user, created: now, modified: now });
          return selectedIssue(ctx, input.id, select);
        },
      },
      deleteIssue: {
        input: deleteInput,
        type: "Issue",
        resolve: ({ ctx, input }: { ctx: Context; input: z.infer<typeof deleteInput> }) => {
          deleteIssue(ctx.db, input.id);
          return null;
        },
      },
      addComment: {
        input: commentInput,
        type: "Comment",
        resolve: ({ ctx, input }: { ctx: Context; input: NewComment }) => {
          if (readIssues(ctx.db, [input.issueId], { description: false, comments: false }).length === 0) {
            throw new FateRequestError("NOT_FOUND", `No issue ${input.issueId}.`);
          }
          const comment = { id: input.id, issueId: input.issueId, body: input.body, username: ctx.user, created: Date.now() };
          insertComment(ctx.db, comment);
          return readComments(ctx.db, [input.id])[0]!;
        },
      },
    },
  });

  // node:sqlite is synchronous and one connection serves every request, so requests run one at a time, and a batch
  // runs one operation at a time, so two durable mutations never open transactions on the connection together.
  let tail: Promise<unknown> = Promise.resolve();
  const handleRequest = (request: Request): Promise<Response> => {
    const task = tail.catch(() => {}).then(async () => {
      const body = (await request.clone().json().catch(() => null)) as { operations?: unknown[]; version?: number } | null;
      if (!Array.isArray(body?.operations) || body.operations.length < 2) return server.handleRequest(request);
      const results: unknown[] = [];
      let version: unknown;
      // Built from the url and headers: the dev server's request object is not one `new Request(request)` accepts.
      const headers = Object.fromEntries(request.headers);
      for (const operation of body.operations) {
        const single = new Request(request.url, { method: "POST", headers, body: JSON.stringify({ ...body, operations: [operation] }) });
        const answer = (await (await server.handleRequest(single)).json()) as { results: unknown[]; version: unknown };
        results.push(...answer.results);
        version = answer.version;
      }
      return Response.json({ results, version }, { headers: { "cache-control": "no-store" } });
    });
    tail = task;
    return task;
  };
  return { handleRequest };
}

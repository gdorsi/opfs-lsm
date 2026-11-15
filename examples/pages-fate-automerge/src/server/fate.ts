import type { DatabaseSync } from "node:sqlite";
import { createMutationIdempotency, type IdempotencyStore, type MutationReceipt } from "@nkzw/fate/persistence/server";
import { createFateServer, dataView, FateRequestError, list, resolveSourceByIds, type SourceDefinition, type SourceRegistry } from "@nkzw/fate/server";
import { z } from "zod";
import { parsePageId } from "../model/bodies.ts";
import { CHILDREN_PAGE, MAX_TITLE, PERSISTENCE_KEY, type NewPage, type PageEntity, type Rename } from "../model/tree.ts";
import type { PageId } from "../model/types.ts";
import { deleteSubtree, insertPage, NoParent, readChildren, readPages, setTitle } from "./pages.ts";

type Context = { readonly db: DatabaseSync };

const pageData = dataView<PageEntity>("Page")({ id: true, parentId: true, title: true });
const pageSource: SourceDefinition<PageEntity> = { id: "id", view: pageData };
const registry: SourceRegistry<Context> = new Map([[pageSource, { byIds: async ({ ctx, ids }: { ctx: Context; ids: readonly string[] }) => readPages(ctx.db, ids) }]] as [
  SourceDefinition<any>,
  SourceRegistry<Context> extends Map<any, infer E> ? E : never,
][]);

const pageId = z.string().transform((raw, ctx) => parsePageId(raw) ?? (ctx.addIssue({ code: "custom", message: "not a page id" }), z.NEVER)) as z.ZodType<PageId>;
const title = z.string().trim().max(MAX_TITLE);
const childrenArgs = z.object({ parent: pageId.nullable(), first: z.number().int().min(1).max(CHILDREN_PAGE), after: z.string().regex(/^\d+$/).optional() });
const createInput: z.ZodType<NewPage> = z.object({ id: pageId, parentId: pageId.nullable(), title });
const renameInput: z.ZodType<Rename> = z.object({ id: pageId, title });
const deleteInput = z.object({ id: pageId });

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value ?? {});
  if (!result.success) throw new FateRequestError("BAD_REQUEST", "Invalid arguments.", { issues: result.error.issues });
  return result.data;
}

async function selectedPage(ctx: Context, id: PageId, select: string[]): Promise<PageEntity> {
  const [page] = await resolveSourceByIds({ ctx, ids: [id], input: { select }, registry, source: pageSource });
  if (!page) throw new FateRequestError("NOT_FOUND", `No page ${id}.`);
  return page as PageEntity;
}

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

export function createServer(db: DatabaseSync) {
  const server = createFateServer({
    context: (): Context => ({ db }),
    idempotency: createMutationIdempotency({ scope: () => PERSISTENCE_KEY, store: receipts }),
    roots: { children: list(pageData) },
    sources: { getSource: () => pageSource as SourceDefinition<any>, registry },
    lists: {
      children: {
        type: "Page",
        resolve: ({ ctx, input }: { ctx: Context; input: { args?: unknown } }) => {
          const { parent, first, after } = parse(childrenArgs, input.args);
          const page = readChildren(ctx.db, { parent, first, ...(after !== undefined && { after: Number(after) }) });
          const cursor = (seq: number) => String(seq);
          return {
            items: page.rows.map(({ seq, ...row }) => ({ cursor: cursor(seq), node: { __typename: "Page" as const, ...row } })),
            // fate reads `hasPrevious` as "rows before this list are missing", so only a later page reports it.
            pagination: { hasNext: page.more, hasPrevious: after !== undefined, nextCursor: page.rows.length > 0 ? cursor(page.rows.at(-1)!.seq) : undefined },
          };
        },
      },
    },
    mutations: {
      createPage: {
        input: createInput,
        type: "Page",
        resolve: async ({ ctx, input, select }: { ctx: Context; input: NewPage; select: string[] }) => {
          try {
            insertPage(ctx.db, input);
          } catch (error) {
            if (error instanceof NoParent) throw new FateRequestError("NOT_FOUND", `No page ${input.parentId}.`);
            throw error;
          }
          return selectedPage(ctx, input.id, select);
        },
      },
      renamePage: {
        input: renameInput,
        type: "Page",
        resolve: async ({ ctx, input, select }: { ctx: Context; input: Rename; select: string[] }) => {
          if (!setTitle(ctx.db, input.id, input.title)) throw new FateRequestError("NOT_FOUND", `No page ${input.id}.`);
          return selectedPage(ctx, input.id, select);
        },
      },
      deletePage: {
        input: deleteInput,
        type: "Page",
        resolve: ({ ctx, input }: { ctx: Context; input: z.infer<typeof deleteInput> }) => {
          deleteSubtree(ctx.db, input.id);
          return null;
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

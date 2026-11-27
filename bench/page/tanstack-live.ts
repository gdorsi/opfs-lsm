/**
 * App code the tanstack-live contenders share: the tracker's screens as
 * TanStack DB live queries, and how a batch of the history is written through
 * the collections. A contender supplies only its collections and, for an
 * on-demand collection, how it writes rows it has not loaded.
 */
import { and, BTreeIndex, coalesce, concat, createLiveQueryCollection, createTransaction, eq, inArray, type Collection, type InitialQueryBuilder } from "@tanstack/db";
import type { LiveScreen, LiveStore, Screen } from "../core/families.ts";
import { LIMITS, OPEN, type Issue, type IssueCard, type Label, type Project, type TrackerSpec, type User } from "../datasets/tracker/types.ts";
import { changesOf, type Change } from "./tracker.ts";

type Rows = { users: User; projects: Project; labels: Label; issues: Issue };
export type Entity = keyof Rows;
export type Collections = { readonly [E in Entity]: Collection<Rows[E], string, any> };
type Row = { readonly id: string };
type Fold = Extract<Change, { kind: "modify" }>["fold"];
type Live = Collection<any, string | number, any>;

/** Writes one entity's part of a batch that touches stored rows: `fold` maps the stored rows of `ids` to the rows after the batch (null deletes). */
export type Modify = (entity: Entity, ids: readonly string[], fold: Fold) => Promise<void>;

/**
 * TanStack DB indexes, which are opt-in, on what the screens filter and sort
 * by. `createIndex` takes one expression. With `byId`, also on `id` of every
 * collection a screen loads by key: an on-demand collection reads the field,
 * not its key column.
 *
 * `status` comes first. Each becomes a SQL index on SQLite, whose planner has
 * no statistics here: between two indexes that each pin one field of a `where`
 * it takes the one created last. A project holds fewer issues than a status
 * does, so `projectId` has to be the later of the two.
 */
export function createIndexes(c: Collections, { byId }: { byId: boolean }): void {
  for (const field of ["status", "projectId", "assigneeId", "updatedAt"] as const) c.issues.createIndex((i) => i[field], { indexType: BTreeIndex });
  if (byId) for (const col of [c.issues, c.users, c.projects] as unknown as Collection<Row, string, any>[]) col.createIndex((r) => r.id, { indexType: BTreeIndex });
}

/** A screen's card before label ids become names. */
type CardRow = Omit<IssueCard, "labels"> & { readonly labelIds: readonly string[] };

/**
 * One screen as an app writes it: the issues it lists, left-joined to their
 * project (for the key) and assignee (for the name), newest update first, 50
 * rows. Every join is a left join, so TanStack loads the window from the issue
 * collection in order rather than every issue the `where` matches.
 */
function screenQuery(c: Collections, screen: Screen, params: TrackerSpec[Screen]["params"]) {
  return (q: InitialQueryBuilder) => {
    const from = q.from({ i: c.issues });
    const p = params as { projectId?: string; status?: string; labelId?: string; userId?: string };
    const listed =
      screen === "statusPage"
        ? from.where(({ i }) => and(eq(i.projectId, p.projectId), eq(i.status, p.status)))
        : screen === "labelPage"
          ? from.where(({ i }) => and(eq(i.projectId, p.projectId), inArray(i.status, [...OPEN]), inArray(p.labelId, i.labelIds)))
          : screen === "myIssues"
            ? from.where(({ i }) => and(eq(i.assigneeId, p.userId), inArray(i.status, [...OPEN])))
            : from;
    return listed
      .leftJoin({ project: c.projects }, ({ i, project }) => eq(i.projectId, project.id))
      .leftJoin({ u: c.users }, ({ i, u }) => eq(i.assigneeId, u.id))
      .orderBy(({ i }) => i.updatedAt, "desc")
      .limit(LIMITS.page)
      .select(({ i, project, u }) => ({
        id: i.id,
        key: concat(project!.key, "-", i.number),
        title: i.title,
        status: i.status,
        priority: i.priority,
        updatedAt: i.updatedAt,
        assignee: coalesce(u!.name, null),
        labelIds: i.labelIds,
      }));
  };
}

/** Resolves once no collection in `all` waits for rows from storage. */
async function idle(all: readonly Live[]): Promise<void> {
  for (;;) {
    const busy = all.find((l) => l.isLoadingSubset);
    if (!busy) return;
    await new Promise<void>((resolve) => {
      const off = busy.on("loadingSubset:change", (e) => {
        if (e.isLoadingSubset) return;
        off();
        resolve();
      });
    });
  }
}

/** The changed fields of `now` over `was`: a patch, as an app writes one. */
function patchOf(was: Row, now: Row): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(now)) if ((was as Record<string, unknown>)[k] !== v) patch[k] = v;
  return patch;
}

/**
 * Writes rows the collection holds: inserts, updates and deletes of a batch in
 * one manual TanStack transaction, which the collection persists in one commit
 * through `utils.acceptMutations`, as TanStack's docs write a multi-operation
 * transaction. `load` makes an on-demand collection hold `ids` first and
 * returns how to let them go.
 */
export function writeHeld(c: Collections, load?: (entity: Entity, ids: readonly string[]) => Promise<() => Promise<void>>): Modify {
  return async (entity, ids, fold) => {
    const col = c[entity] as unknown as Collection<Row, string, any>;
    const release = load ? await load(entity, ids) : undefined;
    try {
      const stored = ids.map((id) => col.get(id));
      const next = fold(stored);
      const inserts: Row[] = [];
      const updates = new Map<string, Record<string, unknown>>();
      const deletes: string[] = [];
      ids.forEach((id, k) => {
        const was = stored[k];
        const now = next[k];
        if (now && !was) inserts.push(now);
        else if (now && was) updates.set(id, patchOf(was, now));
        else if (!now && was) deletes.push(id);
      });
      const tx = createTransaction({ autoCommit: false, mutationFn: ({ transaction }) => col.utils.acceptMutations(transaction) });
      tx.mutate(() => {
        if (inserts.length > 0) col.insert(inserts);
        if (updates.size > 0) {
          col.update([...updates.keys()], (drafts) => {
            for (const d of drafts) Object.assign(d, updates.get(d.id));
          });
        }
        if (deletes.length > 0) col.delete(deletes);
      });
      await tx.commit();
    } finally {
      await release?.();
    }
  };
}

/** Holds `ids` of an on-demand collection with a live query until the returned release. */
export function holdIds(c: Collections): (entity: Entity, ids: readonly string[]) => Promise<() => Promise<void>> {
  return async (entity, ids) => {
    const col = c[entity] as unknown as Collection<Row, string, any>;
    const held = createLiveQueryCollection({ query: (q) => q.from({ r: col }).where(({ r }) => inArray(r.id, [...ids])), startSync: true });
    await held.toArrayWhenReady();
    return () => held.cleanup();
  };
}

export function liveOps(c: Collections, modify: Modify): Omit<LiveStore, "settle" | "stats" | "close"> {
  const open = new Set<Live>();
  const sources = Object.values(c) as unknown as Live[];
  /** Every open query shows what was written: none waits for rows, and neither does a source, through which a join loads the rows it lacks. */
  const shown = () => idle([...open, ...sources]);
  // Every screen maps label ids to names through one live query of all labels, as an app's label list does:
  // TanStack joins only on equality, so a card cannot join the labels its id array names.
  let labels: { readonly live: Live; readonly unsubscribe: () => void; refs: number } | undefined;

  /** Starts a live query the way a screen does: subscribed until it closes, so TanStack keeps it current and never collects it. */
  function subscribed(live: Live): () => void {
    open.add(live);
    const subscription = live.subscribeChanges(() => {}, { includeInitialState: true });
    return () => {
      subscription.unsubscribe();
      open.delete(live);
    };
  }

  async function holdLabels(): Promise<Live> {
    if (!labels) {
      const live = createLiveQueryCollection({ query: (q) => q.from({ l: c.labels }), startSync: true });
      labels = { live, unsubscribe: subscribed(live), refs: 0 };
    }
    const held = labels;
    held.refs++;
    await held.live.toArrayWhenReady();
    await shown();
    return held.live;
  }

  async function dropLabels(): Promise<void> {
    if (!labels || --labels.refs > 0) return;
    const { live, unsubscribe } = labels;
    labels = undefined;
    unsubscribe();
    await live.cleanup();
  }

  return {
    async apply(tx) {
      for (const [entity, change] of changesOf(tx)) {
        if (!(entity in c)) throw new Error(`no collection for ${entity}`);
        const e = entity as Entity;
        if (change.kind === "create") await (c[e] as unknown as Collection<Row, string, any>).insert([...change.rows]).when("settled");
        else await modify(e, change.ids, change.fold);
      }
      await shown();
    },

    async open<S extends Screen>(screen: S, params: TrackerSpec[S]["params"]): Promise<LiveScreen<S>> {
      const names = await holdLabels();
      const live = createLiveQueryCollection({ query: screenQuery(c, screen, params), startSync: true });
      const unsubscribe = subscribed(live);
      await live.toArrayWhenReady();
      await shown();
      const answer = (): IssueCard[] => {
        const name = new Map((names.toArray as Label[]).map((l) => [l.id, l.name]));
        // Each row also carries TanStack's virtual `$` fields, so the card takes its fields by name.
        return (live.toArray as CardRow[]).map((r) => ({
          id: r.id,
          key: r.key,
          title: r.title,
          status: r.status,
          priority: r.priority,
          updatedAt: r.updatedAt,
          assignee: r.assignee,
          labels: r.labelIds.map((id) => name.get(id)!).sort(),
        }));
      };
      return {
        answer: answer as LiveScreen<S>["answer"],
        async close() {
          unsubscribe();
          await live.cleanup();
          await dropLabels();
        },
      };
    },
  };
}

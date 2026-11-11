/**
 * Abstract model of the two stores and the write order of ingest,
 * compaction install, reclaim and recovery (design.md, "Recovery").
 *
 * IndexedDB: `head`, `ingestedThrough`, `generation`, and WAL rows seq ->
 * write id. OPFS: run files (sets of writes) and manifests. A write id
 * stands for one acked batch's content, so a run's content is the set of
 * writes folded into it, and a merge is their union. Each engine action
 * runs against live stores and records its durable ops in order, one
 * IndexedDB commit or one OPFS file op each. A crash state replays a prefix
 * of each store's ops (`replay`), and keeps every strict commit that came
 * before an op it keeps (`possibleCut`).
 */

export type Write = { readonly seq: number; readonly id: number };

/** In `Sys.acked`, a destroy: the writes before it are gone. Write ids start at 1. */
export const DESTROYED = 0;
export type Manifest = {
  readonly gen: number;
  readonly through: number;
  readonly runs: readonly string[];
};

export type Idb = {
  head: number;
  ingested: number;
  generation: number | undefined;
  /** `topGeneration`: the highest manifest number recovery has seen. */
  top: number;
  /** `destroyedTop`: manifests numbered at or below it predate a destroy. */
  destroyedTop: number;
  rows: Map<number, number>;
};
export type Opfs = {
  runs: Map<string, readonly Write[]>;
  manifests: Map<number, Manifest>;
};

export type Op =
  | {
      readonly store: "idb";
      readonly label: string;
      readonly put?: readonly [number, number][];
      /** Delete rows with seq <= this. */
      readonly deleteTo?: number;
      readonly head?: number;
      readonly ingested?: number;
      readonly generation?: number;
      readonly top?: number;
      readonly destroyedTop?: number;
      /** Durability "strict": on disk before the next op of either store starts. */
      readonly strict?: boolean;
    }
  | { readonly store: "opfs"; readonly label: string; readonly run?: [string, readonly Write[]]; readonly manifest?: Manifest; readonly rmRun?: string; readonly rmManifest?: number };

/** Product decisions a broken variant flips, to show the model catches each. */
export type Variant = {
  /** Ingest and compaction build on the newest manifest file, not the recorded one. */
  readonly buildOnNewest?: boolean;
  /** Adopting a manifest leaves `head` where it was. */
  readonly noHeadRaise?: boolean;
  /** No fallback when the recorded manifest is gone: the open fails. */
  readonly noFallback?: boolean;
  /** Never adopt a newer manifest that holds seqs past the head. */
  readonly noNewerAdopt?: boolean;
  /** Number new manifests past `m/` only, forgetting what recovery saw. */
  readonly reuseNumbers?: boolean;
  /**
   * The rule before R1 was fixed: a recorded manifest that is there but
   * lists a run that is gone is treated like a missing one (rule 3), so
   * recovery records an older manifest or generation 0 and drops the WAL.
   */
  readonly lossyRecovery?: boolean;
  /** Destroy removes the files before its IndexedDB commit. */
  readonly destroyFilesFirst?: boolean;
  /** Rule 3 may fall back to a manifest numbered at or below `destroyedTop`. */
  readonly fallBehindDestroy?: boolean;
  /** Destroy commits at the default durability, so its removes can reach the disk first. */
  readonly destroyRelaxed?: boolean;
  /**
   * A tab holds the reclaim lock through the whole run, so the host's
   * manifest and run removals are all skipped (`unlessHeld`). Not a broken
   * design: the property must hold with and without it.
   */
  readonly held?: boolean;
};

export class Stuck extends Error {}

/**
 * Recovery refused: the recorded manifest is there, a run it lists is gone,
 * and no intact manifest holds every ingested seq. Corruption, never a
 * power loss; nothing is written.
 */
export class Refused extends Error {}

export function emptyIdb(): Idb {
  return { head: 0, ingested: 0, generation: undefined, top: 0, destroyedTop: 0, rows: new Map() };
}
export function emptyOpfs(): Opfs {
  return { runs: new Map(), manifests: new Map() };
}
export function cloneIdb(s: Idb): Idb {
  return { ...s, rows: new Map(s.rows) };
}
export function cloneOpfs(s: Opfs): Opfs {
  return { runs: new Map(s.runs), manifests: new Map(s.manifests) };
}

function applyOp(idb: Idb, opfs: Opfs, op: Op): void {
  if (op.store === "idb") {
    if (op.deleteTo !== undefined) for (const seq of [...idb.rows.keys()]) if (seq <= op.deleteTo) idb.rows.delete(seq);
    for (const [seq, id] of op.put ?? []) idb.rows.set(seq, id);
    if (op.head !== undefined) idb.head = op.head;
    if (op.ingested !== undefined) idb.ingested = op.ingested;
    if (op.generation !== undefined) idb.generation = op.generation;
    if (op.top !== undefined) idb.top = op.top;
    if (op.destroyedTop !== undefined) idb.destroyedTop = op.destroyedTop;
  } else {
    if (op.run) opfs.runs.set(op.run[0], op.run[1]);
    if (op.manifest) opfs.manifests.set(op.manifest.gen, op.manifest);
    if (op.rmRun !== undefined) opfs.runs.delete(op.rmRun);
    if (op.rmManifest !== undefined) opfs.manifests.delete(op.rmManifest);
  }
}

/** The crash state that keeps the first `idb` IndexedDB ops and the first `opfs` OPFS ops. */
export function replay(base: { idb: Idb; opfs: Opfs }, ops: readonly Op[], idb: number, opfs: number): { idb: Idb; opfs: Opfs } {
  const out = { idb: cloneIdb(base.idb), opfs: cloneOpfs(base.opfs) };
  let i = 0;
  let o = 0;
  for (const op of ops) {
    if (op.store === "idb" ? i++ < idb : o++ < opfs) applyOp(out.idb, out.opfs, op);
  }
  return out;
}

/**
 * True when a power loss can keep the first `idb` IndexedDB ops and the
 * first `opfs` OPFS ops: every strict commit before a kept op is kept.
 */
export function possibleCut(ops: readonly Op[], idb: number, opfs: number): boolean {
  let i = 0;
  let o = 0;
  /** IndexedDB ops through the last strict commit so far. */
  let need = 0;
  for (const op of ops) {
    if (op.store === "idb") {
      i++;
      if (op.strict) need = i;
    } else if (o++ < opfs && idb < need) {
      return false;
    }
  }
  return true;
}

const ZERO: Manifest = { gen: 0, through: 0, runs: [] };

/** Live stores plus the trace of durable ops the engine wrote to them. */
export class Sys {
  readonly ops: Op[] = [];
  /** Write ids in the order they were acked, and `DESTROYED` for each destroy. */
  readonly acked: number[] = [];

  constructor(
    readonly idb: Idb,
    readonly opfs: Opfs,
    readonly v: Variant,
    private nextId: number,
  ) {}

  private write(op: Op): void {
    applyOp(this.idb, this.opfs, op);
    this.ops.push(op);
  }

  private manifest(gen: number): Manifest | undefined {
    return gen === 0 ? ZERO : this.opfs.manifests.get(gen);
  }

  private intact(m: Manifest | undefined): m is Manifest {
    return m !== undefined && m.runs.every((p) => this.opfs.runs.has(p));
  }

  private numbers(): number[] {
    return [...this.opfs.manifests.keys()].sort((a, b) => b - a);
  }

  /** `reconcile` in src/recover.ts, with `IdBWal.adopt`. */
  reconcile(): { gen: number; top: number } {
    const { head, ingested, generation } = this.idb;
    const numbers = this.numbers();
    const top = this.v.reuseNumbers ? (numbers[0] ?? 0) : Math.max(numbers[0] ?? 0, this.idb.top, generation ?? 0);
    let pick: Manifest | undefined;
    if (!this.v.noNewerAdopt) {
      for (const n of numbers) {
        if (generation !== undefined && n <= generation) break;
        const m = this.manifest(n);
        if (m && m.through > head && this.intact(m)) {
          pick = m;
          break;
        }
      }
    }
    if (!pick && generation !== undefined) {
      const recorded = this.manifest(generation);
      if (this.intact(recorded)) return { gen: generation, top };
      if (recorded && !this.v.lossyRecovery) {
        // R1: only a manifest that holds every ingested seq may stand in.
        pick = numbers.map((n) => this.manifest(n)).find((m) => this.intact(m) && m.through >= ingested);
        if (!pick) throw new Refused(`manifest ${generation} lists a run that is gone`);
      }
      if (!pick && this.v.noFallback) throw new Stuck(`manifest ${generation} is gone`);
    }
    const fallback = this.v.fallBehindDestroy ? numbers : numbers.filter((n) => n > this.idb.destroyedTop);
    pick ??= fallback.map((n) => this.manifest(n)).find((m) => this.intact(m)) ?? ZERO;
    let floor = pick.through;
    for (const n of numbers) floor = Math.max(floor, this.manifest(n)!.through);
    const nextHead = this.v.noHeadRaise ? head : Math.max(head, pick.through, floor);
    const nextTop = Math.max(this.idb.top, top, pick.gen);
    const above = [...this.idb.rows.keys()].filter((s) => s > pick.through && s <= head).length;
    if (nextHead === head && (pick.through >= ingested || above === head - pick.through)) {
      this.write({ store: "idb", label: `adopt ${pick.gen}`, deleteTo: Math.min(ingested, pick.through), ingested: pick.through, generation: pick.gen, head: nextHead, top: nextTop });
    } else {
      this.write({ store: "idb", label: `adopt ${pick.gen} alone`, deleteTo: head, ingested: nextHead, generation: pick.gen, head: nextHead, top: nextTop });
    }
    return { gen: pick.gen, top };
  }

  private base(): { meta: Manifest; top: number } {
    const { gen, top } = this.reconcile();
    if (this.v.buildOnNewest) {
      const newest = this.numbers().map((n) => this.manifest(n)).find((m) => m !== undefined);
      if (newest) return { meta: newest, top };
    }
    const meta = this.manifest(gen);
    if (!meta) throw new Stuck(`manifest ${gen} is gone`);
    return { meta, top };
  }

  append(): void {
    const seq = this.idb.head + 1;
    const id = this.nextId++;
    this.write({ store: "idb", label: `append ${seq}`, put: [[seq, id]], head: seq });
    this.acked.push(id);
  }

  /** `ingestChunk` in src/host/ingest.ts. A chunk is the oldest records that fit the cap: here all of them, or the oldest one. */
  ingest(oldestOnly = false): void {
    const { meta, top } = this.base();
    const waiting = [...this.idb.rows].filter(([s]) => s > this.idb.ingested).sort((a, b) => a[0] - b[0]);
    const rows = oldestOnly ? waiting.slice(0, 1) : waiting;
    if (rows.length === 0) return;
    const first = rows[0]![0];
    const last = rows[rows.length - 1]![0];
    const path = `l0/${first}-${last}`;
    const gen = top + 1;
    this.write({ store: "opfs", label: `publish ${path}`, run: [path, rows.map(([seq, id]) => ({ seq, id }))] });
    this.write({ store: "opfs", label: `publish m/${gen}`, manifest: { gen, through: last, runs: [path, ...meta.runs] } });
    const before = this.idb.ingested;
    this.write({ store: "idb", label: `advanceIngested ${last} gen ${gen}`, deleteTo: before, ingested: last, generation: Math.max(this.idb.generation ?? 0, gen) });
    // `HostedDb.fold`, after `ingestChunk`.
    if (!this.v.held) this.reclaimManifests(this.idb.generation ?? 0);
  }

  /** `mergeNextStep` and `installStep` in src/host/compact.ts: merge every run of the base into one. */
  compact(): void {
    const { meta, top } = this.base();
    if (meta.runs.length < 2) return;
    const merged: Write[] = [];
    for (const p of meta.runs) merged.push(...(this.opfs.runs.get(p) ?? []));
    const path = `l1/c${top + 1}`;
    this.write({ store: "opfs", label: `publish ${path}`, run: [path, merged] });
    const { meta: now, top: top2 } = this.base();
    if (!meta.runs.every((p) => now.runs.includes(p))) return;
    const gen = top2 + 1;
    const runs = [...now.runs.filter((p) => !meta.runs.includes(p)), path];
    this.write({ store: "opfs", label: `publish m/${gen}`, manifest: { gen, through: now.through, runs } });
    this.write({ store: "idb", label: `raiseGeneration ${gen}`, generation: Math.max(this.idb.generation ?? 0, gen) });
    this.sweep();
  }

  /**
   * `HostedDb.destroy`: `recordEmpty` (generation 0, head past every seq the
   * WAL or a manifest names, on disk before it returns), then, unless a tab
   * holds the reclaim lock, every manifest in an unspecified order (newest
   * first here), then a sweep, which against generation 0 removes every run.
   */
  destroy(): void {
    const numbers = this.numbers();
    const top = Math.max(numbers[0] ?? 0, this.idb.top, this.idb.generation ?? 0);
    let floor = this.idb.head;
    for (const n of numbers) floor = Math.max(floor, this.manifest(n)!.through);
    const removeAll = () => {
      if (this.v.held) return;
      for (const n of this.numbers()) this.write({ store: "opfs", label: `remove m/${n}`, rmManifest: n });
      this.sweep();
    };
    if (this.v.destroyFilesFirst) removeAll();
    this.write({ store: "idb", label: "destroy", deleteTo: this.idb.head, head: floor + 1, ingested: floor + 1, generation: 0, top, destroyedTop: top, strict: !this.v.destroyRelaxed });
    this.acked.push(DESTROYED);
    if (!this.v.destroyFilesFirst) removeAll();
  }

  /**
   * `HostedDb.reclaim`: remove the manifests older than the recorded one
   * and every run it does not list. Skipped while a tab holds the lock.
   */
  sweep(): void {
    if (this.v.held) return;
    const { gen } = this.reconcile();
    this.reclaimManifests(gen);
    const keep = new Set(this.manifest(gen)?.runs ?? []);
    for (const p of [...this.opfs.runs.keys()].sort()) {
      if (!keep.has(p)) this.write({ store: "opfs", label: `remove ${p}`, rmRun: p });
    }
  }

  private reclaimManifests(keepFrom: number): void {
    for (const n of this.numbers().reverse()) {
      if (n < keepFrom) this.write({ store: "opfs", label: `remove m/${n}`, rmManifest: n });
    }
  }

  /**
   * `checkDatabase` on a quiet database: the recorded manifest loads with
   * no fallback, holds no seq past ingestedThrough, and the WAL holds
   * every seq in (ingestedThrough, head]. Undefined when healthy.
   */
  problem(): string | undefined {
    const { generation, ingested, head } = this.idb;
    if (generation === undefined) return "no recorded generation";
    const meta = this.manifest(generation);
    if (!this.intact(meta)) return `recorded manifest ${generation} does not load`;
    if (meta.through > ingested) return `manifest through ${meta.through} past ingestedThrough ${ingested}`;
    for (let s = ingested + 1; s <= head; s++) if (!this.idb.rows.has(s)) return `wal gap at ${s}`;
    return undefined;
  }

  /** What a tab reads after `reconcile`: the recorded manifest's runs, then the WAL above ingestedThrough. */
  read(): Set<number> {
    const { gen } = this.reconcile();
    const meta = this.manifest(gen);
    if (!this.intact(meta)) throw new Stuck(`manifest ${gen} does not load`);
    const out = new Set<number>();
    for (const p of meta.runs) for (const w of this.opfs.runs.get(p)!) out.add(w.id);
    for (const [seq, id] of this.idb.rows) if (seq > this.idb.ingested) out.add(id);
    return out;
  }
}

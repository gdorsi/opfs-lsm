/**
 * Abstract model of the three stores and the write order of ingest,
 * compaction install, reclaim, destroy, removal and recovery (design.md,
 * "Recovery").
 *
 * The WAL database (`idb`): the key generator of `wal`, `ingestedThrough`,
 * `generation`, and WAL rows seq -> write id, or undefined when it does not
 * exist. Nothing stores the head: it is the last row, or `ingestedThrough`
 * when no row is past it, and `headOf` finds it the way the product does.
 * The key generator is part of the store, so a crash state that loses
 * commits gets the generator those commits left behind. The destroyed row
 * (`reg`, in `opfs-lsm-destroyed`): its own store, since nothing orders two
 * IndexedDB databases. OPFS: run files (sets of writes) and manifests. A
 * write id stands for one acked batch's content, so a run's content is the
 * set of writes folded into it, and a merge is their union. Each engine
 * action runs against live stores and records its durable ops in order, one
 * IndexedDB commit, database deletion or OPFS file op each. A crash state
 * replays a prefix of each store's ops (`replay`), and keeps every strict op
 * that came before an op it keeps (`possibleCut`).
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
  /** The key generator of `wal`: the seq the next append takes. */
  next: number;
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
/** The destroyed row of the one modeled name: every seq below `head`, every manifest number at most `top`. */
export type Floor = { readonly head: number; readonly top: number };
/** The three stores. `idb` undefined: the WAL database does not exist. */
export type Disk = { idb: Idb | undefined; reg: Floor | undefined; opfs: Opfs };
export type Store = "idb" | "reg" | "opfs";
/** How many ops of each store a crash state keeps. */
export type Cut = Readonly<Record<Store, number>>;

export type Op =
  | {
      readonly store: "idb";
      readonly label: string;
      readonly put?: readonly [number, number][];
      /** Delete rows with seq <= this. */
      readonly deleteTo?: number;
      /** Move the key generator up to this (an `add` at `next - 1`, then its delete). */
      readonly next?: number | undefined;
      readonly ingested?: number;
      readonly generation?: number;
      readonly top?: number;
      readonly destroyedTop?: number;
      /** The WAL database is deleted. The next op starts it from `emptyIdb()`. */
      readonly drop?: true;
      /** Durability "strict": on disk before the next op of any store starts. */
      readonly strict?: boolean;
      /** The commit point of a destroy or a removal: a `DESTROYED` log entry. */
      readonly destroys?: true;
    }
  | {
      readonly store: "reg";
      readonly label: string;
      /** Write the row, keeping the higher of each figure. */
      readonly put?: Floor;
      /** Delete the row if it still reads this. */
      readonly clear?: Floor;
      readonly strict?: boolean;
      readonly destroys?: true;
    }
  | { readonly store: "opfs"; readonly label: string; readonly run?: [string, readonly Write[]]; readonly manifest?: Manifest; readonly rmRun?: string; readonly rmManifest?: number; readonly strict?: undefined; readonly destroys?: undefined };

/** Product decisions a broken variant flips, to show the model catches each. */
export type Variant = {
  /** Ingest and compaction build on the newest manifest file, not the recorded one. */
  readonly buildOnNewest?: boolean;
  /** Adopting a manifest leaves `head` where it was. */
  readonly noHeadRaise?: boolean;
  /** Adopt moves the head past the rows and leaves the key generator behind. */
  readonly adoptKeepsGenerator?: boolean;
  /** Destroy moves the head past the rows and leaves the key generator behind. */
  readonly destroyKeepsGenerator?: boolean;
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
  /** Rule 3 takes the newest manifest numbered past `destroyedTop`, intact or not. */
  readonly fallBackToBroken?: boolean;
  /** Destroy commits at the default durability, so its removes can reach the disk first. */
  readonly destroyRelaxed?: boolean;
  /** `destroyDb` deletes the WAL database and writes no row. */
  readonly removeNoRow?: boolean;
  /** `destroyDb` writes the row at the default durability. */
  readonly rowRelaxed?: boolean;
  /** Recovery runs rules 1 to 3 and ignores the row. */
  readonly birthIgnoresRow?: boolean;
  /** Rule 0 takes its floor from the files on disk, not from the row. */
  readonly birthFloorFromDisk?: boolean;
  /** Rule 0 commits at the default durability, then forgets the row. */
  readonly birthRelaxed?: boolean;
  /** Rule 0 births past the row even when a manifest past the row's `top` shows a database born after it. */
  readonly birthOverOutgrown?: boolean;
  /** `destroyDb` deletes the WAL database before it writes the row. */
  readonly dropFirst?: boolean;
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

function emptyIdb(): Idb {
  return { next: 1, ingested: 0, generation: undefined, top: 0, destroyedTop: 0, rows: new Map() };
}
function emptyOpfs(): Opfs {
  return { runs: new Map(), manifests: new Map() };
}
export function emptyDisk(): Disk {
  return { idb: emptyIdb(), reg: undefined, opfs: emptyOpfs() };
}
function cloneIdb(s: Idb): Idb {
  return { ...s, rows: new Map(s.rows) };
}
export function cloneOpfs(s: Opfs): Opfs {
  return { runs: new Map(s.runs), manifests: new Map(s.manifests) };
}
export function cloneDisk(d: Disk): Disk {
  return { idb: d.idb && cloneIdb(d.idb), reg: d.reg, opfs: cloneOpfs(d.opfs) };
}

/** The last WAL row, or `ingestedThrough` when no row is past it. */
function lastRow(idb: Idb): number {
  let head = idb.ingested;
  for (const seq of idb.rows.keys()) head = Math.max(head, seq);
  return head;
}

/**
 * `headOf` in src/idb/wal.ts: `ingestedThrough` when no row is at
 * `ingestedThrough + 1`, else the last row. It is the head only while the
 * rows past `ingestedThrough` have no gap, which `problem` checks.
 */
function headOf(idb: Idb): number {
  return idb.rows.has(idb.ingested + 1) ? lastRow(idb) : idb.ingested;
}

function applyOp(disk: Disk, op: Op): void {
  const { opfs } = disk;
  if (op.store === "reg") {
    const old = disk.reg;
    if (op.put) disk.reg = { head: Math.max(old?.head ?? 0, op.put.head), top: Math.max(old?.top ?? 0, op.put.top) };
    if (op.clear && old && old.head === op.clear.head && old.top === op.clear.top) disk.reg = undefined;
  } else if (op.store === "idb") {
    if (op.drop) {
      disk.idb = undefined;
      return;
    }
    const idb = (disk.idb ??= emptyIdb());
    if (op.deleteTo !== undefined) for (const seq of [...idb.rows.keys()]) if (seq <= op.deleteTo) idb.rows.delete(seq);
    for (const [seq, id] of op.put ?? []) {
      idb.rows.set(seq, id);
      idb.next = Math.max(idb.next, seq + 1);
    }
    // A delete never moves the key generator back.
    if (op.next !== undefined) idb.next = Math.max(idb.next, op.next);
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

export function count(ops: readonly Op[]): Cut {
  const n = { idb: 0, reg: 0, opfs: 0 };
  for (const op of ops) n[op.store]++;
  return n;
}

/** Calls `fn` with each op and whether `cut` keeps it. */
export function eachKept(ops: readonly Op[], cut: Cut, fn: (op: Op, kept: boolean) => void): void {
  const seen = { idb: 0, reg: 0, opfs: 0 };
  for (const op of ops) fn(op, ++seen[op.store] <= cut[op.store]);
}

/** The crash state that keeps, of each store, the first `cut[store]` ops. */
export function replay(base: Disk, ops: readonly Op[], cut: Cut): Disk {
  const out = cloneDisk(base);
  eachKept(ops, cut, (op, kept) => {
    if (kept) applyOp(out, op);
  });
  return out;
}

/**
 * True when a power loss can keep `cut`: every strict op before a kept op
 * of any store is kept.
 */
export function possibleCut(ops: readonly Op[], cut: Cut): boolean {
  const seen = { idb: 0, reg: 0, opfs: 0 };
  /** Per store, its ops through the last strict one so far. */
  const need = { idb: 0, reg: 0, opfs: 0 };
  for (const op of ops) {
    const n = ++seen[op.store];
    if (n <= cut[op.store] && (cut.idb < need.idb || cut.reg < need.reg || cut.opfs < need.opfs)) return false;
    if (op.strict) need[op.store] = n;
  }
  return true;
}

const ZERO: Manifest = { gen: 0, through: 0, runs: [] };

/** Live stores plus the trace of durable ops the engine wrote to them. */
export class Sys implements Disk {
  readonly ops: Op[] = [];
  /** Write ids in the order they were acked, and `DESTROYED` for each destroy and removal. */
  readonly acked: number[] = [];
  idb: Idb | undefined;
  reg: Floor | undefined;
  readonly opfs: Opfs;

  constructor(
    disk: Disk,
    readonly v: Variant,
    private nextId: number,
  ) {
    ({ idb: this.idb, reg: this.reg, opfs: this.opfs } = disk);
  }

  private write(op: Op): void {
    applyOp(this, op);
    this.ops.push(op);
    if (op.destroys) this.acked.push(DESTROYED);
  }

  /** The WAL database of an open handle. `openDb` creates it when it is missing. */
  private wal(): Idb {
    return (this.idb ??= emptyIdb());
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

  /** The highest `through` of the manifests on disk, and at least `from`. */
  private highestThrough(from: number): number {
    let floor = from;
    for (const n of this.numbers()) floor = Math.max(floor, this.manifest(n)!.through);
    return floor;
  }

  /** `reconcile` in src/recover.ts, with `adopt` in src/idb/wal.ts. */
  reconcile(): { gen: number; top: number } {
    const idb = this.wal();
    const { ingested, generation } = idb;
    const head = headOf(idb);
    const numbers = this.numbers();
    const top = this.v.reuseNumbers ? (numbers[0] ?? 0) : Math.max(numbers[0] ?? 0, idb.top, generation ?? 0);
    const known = this.reg;
    if (generation === undefined && known && !this.v.birthIgnoresRow) {
      // Rule 0: a strict birth past the row, then forget the row. A manifest
      // past the row's top was written by a database born after it: birth at
      // the row's own figures, then rules 1 to 3 recover that database.
      const outgrown = !this.v.birthOverOutgrown && (numbers[0] ?? 0) > known.top;
      const floor = { head: this.highestThrough(head) + 1, top };
      const past = this.v.birthFloorFromDisk ? floor : { head: Math.max(floor.head, known.head), top: Math.max(floor.top, known.top) };
      const born = outgrown ? known : past;
      this.write({ store: "idb", label: "birth", deleteTo: head, ingested: born.head, generation: 0, next: born.head + 1, top: born.top, destroyedTop: born.top, strict: !this.v.birthRelaxed });
      this.write({ store: "reg", label: "forget the row", clear: known });
      return outgrown ? this.reconcile() : { gen: 0, top: born.top };
    }
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
    const fallback = this.v.fallBehindDestroy ? numbers : numbers.filter((n) => n > idb.destroyedTop);
    pick ??= fallback.map((n) => this.manifest(n)).find((m) => (this.v.fallBackToBroken ? m !== undefined : this.intact(m))) ?? ZERO;
    const floor = this.highestThrough(pick.through);
    const past = this.v.noHeadRaise ? head : Math.max(head, pick.through, floor);
    const nextTop = Math.max(idb.top, top, pick.gen);
    const above = [...idb.rows.keys()].filter((s) => s > pick.through && s <= head).length;
    const follows = past === head && (pick.through >= ingested || above === head - pick.through);
    // Dropping the rows changes the state, so the head moves by at least one.
    const nextHead = follows || this.v.noHeadRaise ? head : Math.max(past, head + 1);
    if (follows) {
      this.write({ store: "idb", label: `adopt ${pick.gen}`, deleteTo: Math.min(ingested, pick.through), ingested: pick.through, generation: pick.gen, top: nextTop });
    } else {
      // `passKeyGenerator`: the head moved past the rows, so the generator moves with it.
      const next = nextHead > head && !this.v.adoptKeepsGenerator ? nextHead + 1 : undefined;
      this.write({ store: "idb", label: `adopt ${pick.gen} alone`, deleteTo: head, ingested: nextHead, generation: pick.gen, next, top: nextTop });
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

  /** `TabWal.appendAfter`, the write of `update`: the record goes in at the explicit key `head + 1`. */
  appendAfter(): void {
    const seq = headOf(this.wal()) + 1;
    const id = this.nextId++;
    this.write({ store: "idb", label: `append ${seq} after the head`, put: [[seq, id]] });
    this.acked.push(id);
  }

  /** `TabWal.append`: the record takes the seq the key generator hands out. */
  append(): void {
    const seq = this.wal().next;
    const id = this.nextId++;
    this.write({ store: "idb", label: `append ${seq}`, put: [[seq, id]] });
    this.acked.push(id);
  }

  /** `ingestChunk` in src/host/ingest.ts. A chunk is the oldest records that fit the cap: here all of them, or the oldest one. */
  ingest(oldestOnly = false): void {
    const { meta, top } = this.base();
    const idb = this.wal();
    const waiting = [...idb.rows].filter(([s]) => s > idb.ingested).sort((a, b) => a[0] - b[0]);
    const rows = oldestOnly ? waiting.slice(0, 1) : waiting;
    if (rows.length === 0) return;
    const first = rows[0]![0];
    const last = rows[rows.length - 1]![0];
    const path = `l0/${first}-${last}`;
    const gen = top + 1;
    this.write({ store: "opfs", label: `publish ${path}`, run: [path, rows.map(([seq, id]) => ({ seq, id }))] });
    this.write({ store: "opfs", label: `publish m/${gen}`, manifest: { gen, through: last, runs: [path, ...meta.runs] } });
    const before = idb.ingested;
    this.write({ store: "idb", label: `advanceIngested ${last} gen ${gen}`, deleteTo: before, ingested: last, generation: Math.max(idb.generation ?? 0, gen) });
    // `HostedDb.fold`, after `ingestChunk`.
    if (!this.v.held) this.reclaimManifests(this.wal().generation ?? 0);
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
    this.write({ store: "idb", label: `raiseGeneration ${gen}`, generation: Math.max(this.wal().generation ?? 0, gen) });
    this.sweep();
  }

  /**
   * `recordEmpty` in src/recover.ts: in one strict commit, generation 0, with
   * the head one past every seq the WAL or a manifest names and `destroyedTop`
   * at the highest manifest number, each at least `known`'s. Returns them.
   */
  private recordEmpty(label: string, known: Floor | undefined): Floor {
    const idb = this.wal();
    const numbers = this.numbers();
    const head = headOf(idb);
    let floor = { head: this.highestThrough(head) + 1, top: Math.max(numbers[0] ?? 0, idb.top, idb.generation ?? 0) };
    if (known) floor = { head: Math.max(floor.head, known.head), top: Math.max(floor.top, known.top) };
    const next = this.v.destroyKeepsGenerator ? undefined : floor.head + 1;
    this.write({ store: "idb", label, deleteTo: head, ingested: floor.head, generation: 0, next, top: floor.top, destroyedTop: floor.top, strict: !this.v.destroyRelaxed, destroys: true });
    return floor;
  }

  /**
   * `HostedDb.destroy`: `recordEmpty`, then, unless a tab holds the reclaim
   * lock, every manifest in an unspecified order (newest first here), then a
   * sweep, which against generation 0 removes every run.
   */
  destroy(): void {
    const removeAll = () => {
      if (this.v.held) return;
      for (const n of this.numbers()) this.write({ store: "opfs", label: `remove m/${n}`, rmManifest: n });
      this.sweep();
    };
    if (this.v.destroyFilesFirst) removeAll();
    this.recordEmpty("destroy", undefined);
    if (!this.v.destroyFilesFirst) removeAll();
  }

  /**
   * `removeDatabase` in src/destroy.ts, the work of `destroyDb`. With the WAL
   * database: `recordEmpty`, the row (strict), every manifest then every run,
   * whatever tab holds them, then the deletion of the WAL database. Without
   * it: the row from the manifests on disk, when there is one, then the
   * files. With neither store it writes nothing.
   */
  remove(): void {
    const hadWal = this.idb !== undefined;
    if (!hadWal && this.opfs.runs.size === 0 && this.opfs.manifests.size === 0) return;
    const known = this.reg;
    let floor: Floor | undefined;
    if (hadWal) floor = this.recordEmpty("remove: empty", known);
    else if (this.opfs.manifests.size > 0) {
      const top = Math.max(this.numbers()[0]!, known?.top ?? 0);
      floor = { head: Math.max(this.highestThrough(0) + 1, known?.head ?? 0), top };
    }
    if (hadWal && this.v.dropFirst) this.write({ store: "idb", label: "remove: drop", drop: true });
    if (floor && !this.v.removeNoRow) {
      this.write({ store: "reg", label: "remove: row", put: floor, strict: !this.v.rowRelaxed, ...(hadWal ? {} : { destroys: true as const }) });
    }
    // A recursive removal promises no order: one order (manifests newest first, then runs) stands for all.
    for (const n of this.numbers()) this.write({ store: "opfs", label: `remove m/${n}`, rmManifest: n });
    for (const p of [...this.opfs.runs.keys()].sort()) this.write({ store: "opfs", label: `remove ${p}`, rmRun: p });
    if (hadWal && !this.v.dropFirst) this.write({ store: "idb", label: "remove: drop", drop: true });
  }

  /** True when neither the WAL database nor any OPFS file is left. */
  gone(): boolean {
    return this.idb === undefined && this.opfs.runs.size === 0 && this.opfs.manifests.size === 0;
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
   * every seq in (ingestedThrough, head]. The key generator is one past the
   * head, so `append` and `appendAfter` take the same seq. Undefined when
   * healthy.
   */
  problem(): string | undefined {
    const idb = this.wal();
    const { generation, ingested } = idb;
    const head = lastRow(idb);
    if (generation === undefined) return "no recorded generation";
    const meta = this.manifest(generation);
    if (!this.intact(meta)) return `recorded manifest ${generation} does not load`;
    if (meta.through > ingested) return `manifest through ${meta.through} past ingestedThrough ${ingested}`;
    for (let s = ingested + 1; s <= head; s++) if (!idb.rows.has(s)) return `wal gap at ${s}`;
    if (idb.next !== head + 1) return `key generator at ${idb.next} with the head at ${head}`;
    return undefined;
  }

  /** What a tab reads after `reconcile`: the recorded manifest's runs, then the WAL in (ingestedThrough, head]. */
  read(): Set<number> {
    const { gen } = this.reconcile();
    const meta = this.manifest(gen);
    if (!this.intact(meta)) throw new Stuck(`manifest ${gen} does not load`);
    const idb = this.wal();
    const out = new Set<number>();
    for (const p of meta.runs) for (const w of this.opfs.runs.get(p)!) out.add(w.id);
    for (let seq = idb.ingested + 1; seq <= headOf(idb); seq++) {
      const id = idb.rows.get(seq);
      if (id === undefined) throw new Stuck(`wal gap at ${seq}`);
      out.add(id);
    }
    return out;
  }
}

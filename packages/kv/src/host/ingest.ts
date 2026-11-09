import { opsBytes } from "../check.js";
import { parseSegment, segmentPath, tabDir, type Stamp } from "../log/frame.js";
import { liveTabs } from "../log/liveness.js";
import { TAB_START, lastRecordOf, lastStampOf, listSegments, listTabs, readTab } from "../log/reader.js";
import type { AsyncFs } from "../opfs/async-fs.js";
import { recoverGeneration } from "../recover.js";
import { foldRecords } from "../store/fold.js";
import { manifestNumbers, probeManifest, publishGeneration, publishL0 } from "../store/generation.js";
import type { WalRecord } from "../store/memtable.js";

export type IngestResult = {
  readonly generation: number;
  /** The cut of that generation. */
  readonly cut: Stamp;
  /** Op bytes of the log records this call folded into the new L0. */
  readonly foldedBytes: number;
};

/**
 * Fold every tab's log records above the committed generation's cut and at
 * or below `cut` into one L0, and publish the next generation, which
 * commits it. A tab only asks for a cut its watermark passed and its log
 * holds durably, so every record at or below it is already in some log,
 * and every tab orders and numbers them the same way: by (stamp, tab), on
 * from the base's `through`. Folds nothing when the committed cut already
 * reaches `cut`. Run under the ingest lock.
 */
export async function ingestThrough(
  fs: AsyncFs,
  name: string,
  asked: Stamp,
  trust: (generation: number) => boolean = () => false,
): Promise<IngestResult> {
  const { meta: base, top } = await recoverGeneration(fs, trust, { underIngestLock: true });
  const cut = asked === Number.POSITIVE_INFINITY ? await cutNow(fs, name, base.cut) : asked;
  if (cut <= base.cut) return { generation: base.generation, cut: base.cut, foldedBytes: 0 };
  const picked: { stamp: Stamp; tab: string; rec: WalRecord["ops"] }[] = [];
  for (const tab of await listTabs(fs)) {
    const read = await readTab(fs, tab, TAB_START, base.cut);
    for (const r of read.records) {
      if (r.stamp > base.cut && r.stamp <= cut) picked.push({ stamp: r.stamp, tab, rec: r.ops });
    }
  }
  picked.sort((a, b) => a.stamp - b.stamp || (a.tab < b.tab ? -1 : a.tab > b.tab ? 1 : 0));
  const records: WalRecord[] = picked.map((p, i) => ({ seq: base.through + 1 + i, ops: p.rec }));
  const generation = top + 1;
  const through = base.through + records.length;
  let runs = base.runs;
  let foldedBytes = 0;
  if (records.length > 0) {
    const l0 = await publishL0(fs, `${base.through + 1}-${through}`, foldRecords(records));
    runs = [l0, ...base.runs];
    for (const r of records) foldedBytes += opsBytes(r.ops);
  }
  await publishGeneration(fs, { generation, runs, tombstoneSeq: base.tombstoneSeq, through, cut });
  return { generation, cut, foldedBytes };
}

/**
 * A cut the host can pick on its own, for an ingest of "everything" no tab
 * asked a cut for (tests, tools). The logs' last stamps are read first,
 * the live tabs after. A tab live then whose last record was read only
 * writes above it, so the lowest such last record is safe. A tab live then
 * that showed no record could still write below anything: it holds the cut
 * where it is. A tab that becomes live later reads the logs first, and
 * writes above every last record in them. A tab not live is dead, and the
 * fold reads its log after this.
 */
async function cutNow(fs: AsyncFs, name: string, base: Stamp): Promise<Stamp> {
  const lasts = new Map<string, Stamp>();
  let top = base;
  for (const tab of await listTabs(fs)) {
    const files = await listSegments(fs, tab);
    if (files.length === 0) continue;
    const last = await lastStampOf(fs, tab, files[files.length - 1]!);
    lasts.set(tab, last);
    if (last > top) top = last;
  }
  let cut = Number.POSITIVE_INFINITY;
  for (const tab of await liveTabs(name)) {
    const last = lasts.get(tab);
    if (last === undefined) return base;
    cut = Math.min(cut, last);
  }
  return cut === Number.POSITIVE_INFINITY ? top : cut;
}

/**
 * Remove log segments the committed generation covers: a sealed segment
 * whose records are all at or below `cut`, and the last segment of a dead
 * tab once it is covered too. A live tab's open segment is never removed.
 * Best-effort: a removal that fails is retried by the next ingest.
 *
 * A dead tab's last segment gives way to an empty one named past its last
 * record, a tombstone: the log reads as reclaimed through that stamp, as
 * when its first segments go. Without it the whole log would vanish, and
 * neither recovery (an older manifest standing in, `recoverGeneration`)
 * nor a tab that missed those records could tell they ever existed. The
 * tombstone goes once every manifest on disk covers it.
 */
export async function reclaimLogs(fs: AsyncFs, name: string, cut: Stamp): Promise<void> {
  const live = await liveTabs(name);
  let lowestCut: Stamp | undefined;
  const everyManifestCovers = async (stamp: Stamp) => {
    lowestCut ??= await lowestManifestCut(fs);
    return lowestCut >= stamp;
  };
  for (const tab of await listTabs(fs)) {
    const files = await listSegments(fs, tab);
    for (let i = 0; i < files.length; i++) {
      const next = files[i + 1];
      const path = `${tabDir(tab)}/${files[i]}`;
      if (next) {
        // Every record of segment i is below the next segment's first record,
        // and the next one's name holds the stamp of segment i's last record.
        if (parseSegment(next)!.prevStamp > cut) break;
        await fs.remove(path).catch(() => undefined);
        continue;
      }
      if (live.has(tab)) break;
      const last = await lastRecordOf(fs, tab, files[i]!);
      if (last.stamp > cut) break;
      const seg = parseSegment(files[i]!)!;
      if (last.n === seg.firstN - 1) {
        // Empty: a tombstone, or a segment never written.
        if (!(await everyManifestCovers(seg.prevStamp))) break;
        await fs.remove(path).catch(() => undefined);
        await fs.remove(tabDir(tab)).catch(() => undefined);
        break;
      }
      try {
        const w = await fs.create(segmentPath(tab, { firstN: last.n + 1, prevStamp: last.stamp }));
        await w.finish();
      } catch {
        break;
      }
      await fs.remove(path).catch(() => undefined);
    }
  }
}

/** The lowest cut of the manifests on disk: an older one may still stand in for a newer one. */
async function lowestManifestCut(fs: AsyncFs): Promise<Stamp> {
  let lowest = Number.POSITIVE_INFINITY;
  for (const n of await manifestNumbers(fs)) {
    const m = await probeManifest(fs, n);
    if (typeof m === "object") lowest = Math.min(lowest, m.cut);
  }
  return lowest;
}

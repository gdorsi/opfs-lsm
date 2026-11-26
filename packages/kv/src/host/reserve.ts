import { isQuota } from "../errors.js";
import type { AsyncFs, FileWriter } from "../opfs/async-fs.js";
import type { Seq } from "../seq.js";

/**
 * The reserve file, in the database folder. Outside `m/` and `l<n>/`, so
 * neither sweep lists it, and `destroyDb` removes it with the folder.
 */
export const RESERVE_PATH = "reserve";
/** What Chrome leaves next to the reserve when the browser dies during a fill. */
const SWAP_PATH = `${RESERVE_PATH}.crswap`;
const FILL_CHUNK_BYTES = 1024 * 1024;

/**
 * Whether the host asks the handlers again. `offered`: an offer is out, posted
 * when the WAL head was `head`. `after`: answered when the head was `seq`.
 */
type Ask = { readonly kind: "offered"; readonly head: Seq } | { readonly kind: "after"; readonly seq: Seq };

/**
 * What one host knows of a database's reserve. The file on disk is the truth
 * across hosts and restarts.
 */
export type Reserve =
  /** Not looked at since the host started, the last tab closed, or a tab opened. */
  | { readonly kind: "unknown" }
  /** The file holds `bytes`. 0: there is none. */
  | { readonly kind: "held"; readonly bytes: number }
  /** A refused write took the file, or it never fit. */
  | { readonly kind: "released"; readonly ask: Ask };

export type ReserveEvent =
  /** A compaction pass found nothing to plan, with the log ingested through `ingestedThrough`. `target` is the size the tabs ask for. */
  | { readonly kind: "settle"; readonly ingestedThrough: Seq; readonly head: Seq; readonly target: number }
  /** The browser refused a write of the host or of a tab. Not sent while the target is 0. */
  | { readonly kind: "refused"; readonly head: Seq }
  /** A handle took the lock that answers offers. */
  | { readonly kind: "pull" }
  /** The handlers settled, or no handle has one. */
  | { readonly kind: "done"; readonly head: Seq; readonly ingestedThrough: Seq }
  /** A tab opened the database. */
  | { readonly kind: "watch" }
  /** The last tab closed the database. */
  | { readonly kind: "last-unwatch" }
  /** The outcome of `inspect`: the file holds `bytes`, 0 when there is none. */
  | { readonly kind: "found"; readonly bytes: number; readonly head: Seq; readonly target: number }
  /** The outcomes of `fill`. */
  | { readonly kind: "filled"; readonly bytes: number }
  | { readonly kind: "fill-refused"; readonly head: Seq };

/** What the host does for a transition. `inspect` and `fill` answer with an event. */
export type ReserveEffect =
  | { readonly kind: "none" }
  | { readonly kind: "inspect"; readonly head: Seq; readonly target: number }
  | { readonly kind: "fill"; readonly head: Seq; readonly target: number }
  /** Remove the file, with no offer: no tab wants a reserve. */
  | { readonly kind: "remove" }
  /** Remove the file, then post the offer. The refused write can run again. */
  | { readonly kind: "release" }
  /** Post the offer. */
  | { readonly kind: "offer" }
  /** Flush and compact now: the log holds records the answer waits for, too few bytes to reach a flush trigger. */
  | { readonly kind: "flush" };

type Moved = { readonly next: Reserve; readonly effect: ReserveEffect };

const NONE: ReserveEffect = { kind: "none" };
const UNKNOWN: Reserve = { kind: "unknown" };

function offered(head: Seq): Reserve {
  return { kind: "released", ask: { kind: "offered", head } };
}

/**
 * The transition table (docs/reserve.md). The host refills the reserve, or
 * asks the handlers again, only at a `settle` that has ingested what they
 * wrote last time, so an answer that freed nothing is never asked in a loop.
 * A pair with no row changes nothing, which makes a duplicate event harmless.
 */
export function step(state: Reserve, event: ReserveEvent): Moved {
  if (event.kind === "last-unwatch") return { next: UNKNOWN, effect: NONE };
  switch (state.kind) {
    case "unknown":
      switch (event.kind) {
        case "settle":
          // No tab wants a reserve: whatever an earlier session left goes, unseen.
          if (event.target === 0) return { next: { kind: "held", bytes: 0 }, effect: { kind: "remove" } };
          return { next: state, effect: { kind: "inspect", head: event.head, target: event.target } };
        case "found":
          if (event.bytes === event.target) return { next: { kind: "held", bytes: event.bytes }, effect: NONE };
          return {
            next: { kind: "held", bytes: event.bytes },
            effect: { kind: "fill", head: event.head, target: event.target },
          };
        case "refused":
          return { next: offered(event.head), effect: { kind: "release" } };
      }
      break;
    case "held":
      switch (event.kind) {
        case "settle":
          if (state.bytes < event.target) {
            return { next: state, effect: { kind: "fill", head: event.head, target: event.target } };
          }
          break;
        case "filled":
          return { next: { kind: "held", bytes: event.bytes }, effect: NONE };
        case "fill-refused":
          // A refused rewrite leaves the smaller file in place.
          if (state.bytes === 0) return { next: offered(event.head), effect: { kind: "offer" } };
          break;
        case "refused":
          return { next: offered(event.head), effect: { kind: state.bytes > 0 ? "release" : "offer" } };
        case "watch":
          return { next: UNKNOWN, effect: NONE };
      }
      break;
    case "released":
      if (state.ask.kind === "offered") {
        switch (event.kind) {
          case "pull":
            return { next: state, effect: { kind: "offer" } };
          case "done":
            return {
              next: { kind: "released", ask: { kind: "after", seq: event.head } },
              effect: event.head > state.ask.head || event.head > event.ingestedThrough ? { kind: "flush" } : NONE,
            };
        }
        break;
      }
      switch (event.kind) {
        case "settle":
          if (event.ingestedThrough >= state.ask.seq) {
            return { next: state, effect: { kind: "fill", head: event.head, target: event.target } };
          }
          break;
        case "filled":
          return { next: { kind: "held", bytes: event.bytes }, effect: NONE };
        case "fill-refused":
          return { next: offered(event.head), effect: { kind: "offer" } };
      }
      break;
  }
  return { next: state, effect: NONE };
}

async function removeQuietly(fs: AsyncFs, path: string): Promise<void> {
  await fs.remove(path).catch(() => undefined);
}

/** Bytes the reserve file holds, 0 when there is none. Removes the swap file of a fill a crash cut off. */
export async function inspectReserve(fs: AsyncFs): Promise<number> {
  await removeQuietly(fs, SWAP_PATH);
  const file = await fs.open(RESERVE_PATH);
  file?.close();
  return file?.size ?? 0;
}

export async function removeReserve(fs: AsyncFs): Promise<void> {
  await removeQuietly(fs, RESERVE_PATH);
  await removeQuietly(fs, SWAP_PATH);
}

/**
 * Write `target` zero bytes to the reserve file. Written, not truncated: a
 * sparse file holds quota and no disk blocks, and a full disk refuses a
 * write like a full quota does. "quota" when the browser refuses: the file
 * is then as it was.
 */
export async function fillReserve(fs: AsyncFs, target: number): Promise<"ok" | "quota"> {
  await removeQuietly(fs, SWAP_PATH);
  let writer: FileWriter | undefined;
  try {
    writer = await fs.create(RESERVE_PATH);
    const chunk = new Uint8Array(Math.min(target, FILL_CHUNK_BYTES));
    for (let left = target; left > 0; left -= chunk.byteLength) {
      await writer.write(left < chunk.byteLength ? chunk.subarray(0, left) : chunk);
    }
    await writer.finish();
    return "ok";
  } catch (err) {
    await writer?.abort().catch(() => undefined);
    if (isQuota(err)) return "quota";
    throw err;
  }
}

/**
 * Jazzer.js entry points over the wasm engine, one per export family.
 * libFuzzer's coverage is the checked twin's own: each function entry, if
 * arm and loop head bumps a counter Jazzer registered (`run.ts` instruments
 * no JavaScript for these targets). The input is read as the choices of a
 * drive case (`../engine-drive.ts`), so mutations reach the merge session
 * behind valid runs. A finding is a memory error (`SanitizerError`), a trap,
 * a block or memory past the limit, or the twin and the shipped build
 * disagreeing.
 */
import { openChecked, openShipped } from "../../checked/engine-under-test.ts";
import { bytesSource, driveEncode, driveMerge, driveScan, encodeCase, mergeCase, scanCase, type Transcript } from "../engine-drive.ts";

declare const Fuzzer: { coverageTracker: { createModuleCounters(size: number): Uint8Array } };

const LIMIT = 64 << 20;

let counters: Uint8Array | undefined;
/** Every twin bumps the counters libFuzzer registered for the first. */
const coverage = (edges: number) => (counters ??= Fuzzer.coverageTracker.createModuleCounters(edges));
// Opened as the module loads, so libFuzzer registers the twin's counters when it starts.
let twin = openChecked({ coverage });
let shipped = openShipped();

function agree(what: string, got: Transcript, want: Transcript, mayTrap = false): void {
  const trap = want.find((line) => line.startsWith("TRAP"));
  if (trap && !mayTrap) throw new Error(`${what}: ${trap}`);
  if (got.join("\n") !== want.join("\n")) throw new Error(`${what}: the twin and the shipped build disagree`);
  if (shipped.memory.buffer.byteLength > LIMIT) throw new Error(`${what}: memory reached ${shipped.memory.buffer.byteLength} bytes`);
  if (twin.largestAllocation() > LIMIT) throw new Error(`${what}: asked for a block of ${twin.largestAllocation()} bytes`);
  // A trapped call keeps what it allocated, so the next input starts on fresh instances, as the host restarts its engine, and replays alone.
  if (trap) {
    twin = openChecked({ coverage });
    shipped = openShipped();
  }
}

export function engineEncode(data: Uint8Array): void {
  const c = encodeCase(bytesSource(data));
  agree("encode", driveEncode(twin.exports, c), driveEncode(shipped, c));
}

export function engineScan(data: Uint8Array): void {
  const c = scanCase(bytesSource(data), shipped);
  agree("scan", driveScan(twin.exports, c), driveScan(shipped, c));
}

export function engineMerge(data: Uint8Array): void {
  const c = mergeCase(bytesSource(data), shipped);
  agree("merge", driveMerge(twin.exports, c), driveMerge(shipped, c), c.badMarks);
}

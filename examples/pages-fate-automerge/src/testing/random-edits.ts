import type { Block, Depth, MarkName, Marks, TextEdit } from "../model/types.ts";
import type { ReferenceBody } from "./reference.ts";

/** mulberry32: a small seeded generator, so a failing seed replays exactly. */
export function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TEXTS = ["a", "b", "xy", " ", "é", "hello"];
const LINKS = ["https://a.example", "https://b.example"];
const NAMES: readonly MarkName[] = ["bold", "italic", "code", "link"];

/**
 * A batch of 1 to 3 random edits, each valid against the body the edits
 * before it leave. It applies them to `body` as it goes, so `body` ends up
 * where the model should be after `edit(batch)`.
 */
export function randomBatch(rand: () => number, body: ReferenceBody): TextEdit[] {
  const int = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1));
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
  const depth = () => int(0, 5) as Depth;
  const block = (): Block =>
    pick<() => Block>([
      () => ({ type: "paragraph" }),
      () => ({ type: "heading", level: int(1, 3) as 1 | 2 | 3 }),
      () => ({ type: "item", list: pick(["bullet", "number"] as const), depth: depth() }),
      () => ({ type: "todo", depth: depth(), checked: rand() < 0.5 }),
    ])();
  const marks = (): Marks => ({
    ...(rand() < 0.25 && { bold: true }),
    ...(rand() < 0.2 && { italic: true }),
    ...(rand() < 0.15 && { code: true }),
    ...(rand() < 0.15 && { link: pick(LINKS) }),
  });

  const batch: TextEdit[] = [];
  for (let n = int(1, 3); n > 0; n--) {
    const length = body.length();
    const r = rand();
    let edit: TextEdit;
    if (r < 0.45 || length < 3) {
      edit = { type: "insert", at: int(1, length), text: pick(TEXTS), marks: marks() };
    } else if (r < 0.62) {
      const at = int(1, length - 1);
      edit = { type: "delete", at, count: Math.min(length - at, int(1, 6)) };
    } else if (r < 0.72) {
      edit = { type: "split", at: int(1, length), block: block() };
    } else if (r < 0.8) {
      edit = { type: "setBlock", at: pick(body.blocks()), block: block() };
    } else {
      const start = int(0, length - 1);
      const end = Math.min(length, start + int(1, 10));
      const name = pick(NAMES);
      const remove = rand() < 0.3;
      edit =
        name === "link"
          ? { type: "mark", start, end, name, value: remove ? null : pick(LINKS) }
          : { type: "mark", start, end, name, value: remove ? null : true };
    }
    body.edit([edit]);
    batch.push(edit);
  }
  return batch;
}

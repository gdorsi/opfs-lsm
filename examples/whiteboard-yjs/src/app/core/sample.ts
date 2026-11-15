/**
 * Sample boards for the 5,000 and 20,000 shape checks: the same mix and world as the bench's whiteboard workloads
 * (40% rect/ellipse/diamond, 15% text, 15% arrows, 30% pen strokes of 5 to 60 points, over 20,000 x 20,000).
 * Seeded, so every run of the browser proof draws the same board. Pure.
 */
import { penShape, type NewShape, type Point, type Style } from "../../model/index.ts";

export const SAMPLE_SIZES = [5_000, 20_000] as const;

const WORLD = 20_000;
const COLORS = ["#111111", "#e03131", "#2f9e44", "#1971c2", "#f08c00", "#9c36b5"];

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `count` shapes from `seed`, for the caller to dispatch in chunks. */
export function sampleShapes(count: number, seed: number): NewShape[] {
  const rng = mulberry32(seed);
  const between = (lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));
  const pick = <T>(items: readonly T[]): T => items[between(0, items.length - 1)]!;
  const style = (): Style => ({ stroke: pick(COLORS), fill: rng() < 0.4 ? pick(COLORS) : null, strokeWidth: pick([1, 2, 4, 8]) });

  return Array.from({ length: count }, (): NewShape => {
    const frame = { x: between(0, WORLD), y: between(0, WORLD), w: between(20, 300), h: between(20, 200) };
    const roll = rng();
    if (roll < 0.4) return { kind: pick(["rect", "ellipse", "diamond"] as const), ...frame, ...style() };
    if (roll < 0.55) return { kind: "text", ...frame, ...style(), fill: null, text: `note ${between(0, 9999)}`, fontSize: pick([12, 16, 24]) };
    if (roll < 0.7) return { kind: "arrow", ...frame, ...style(), fill: null };
    const points: Point[] = [];
    let at = { x: frame.x, y: frame.y };
    for (let i = between(5, 60); i > 0; i--) {
      at = { x: at.x + between(-12, 12), y: at.y + between(-12, 12) };
      points.push(at);
    }
    return penShape(points, { ...style(), fill: null });
  });
}

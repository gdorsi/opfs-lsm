import { CODES, type Issue } from "./model.ts";

// LinearLite's seed (examples/linearlite/scripts/generate.ts) without descriptions, comments and board order.

const WORDS =
  "lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud exercitation ullamco laboris nisi aliquip ex ea commodo consequat duis aute irure in reprehenderit voluptate velit esse cillum fugiat nulla pariatur excepteur sint occaecat cupidatat non proident sunt culpa qui officia deserunt mollit anim id est laborum sync cache index query render latency offline tab worker cursor snapshot".split(
    " ",
  );
const NAMES = ["ada", "grace", "linus", "barbara", "ken", "margaret", "dennis", "radia", "alan", "frances", "edsger", "hedy"];

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `count` issues created in the year before 1 November 2026. The same seed gives the same issues. */
export function generate(count: number, seed = 1): Issue[] {
  const r = rng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const title = () => {
    const s = Array.from({ length: 3 + Math.floor(r() * 6) }, () => pick(WORDS)).join(" ");
    return s[0]!.toUpperCase() + s.slice(1);
  };
  const uuid = () => {
    const h = Array.from({ length: 32 }, () => Math.floor(r() * 16).toString(16)).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
  };
  const now = Date.UTC(2026, 10, 1);
  const year = 365 * 24 * 3600 * 1000;
  const issues: Issue[] = [];
  for (let i = 0; i < count; i++) {
    const created = now - Math.floor(r() * year);
    issues.push({
      id: uuid(),
      title: title(),
      status: pick(CODES),
      priority: pick(CODES),
      username: pick(NAMES),
      created,
      modified: created + Math.floor(r() * (now - created)),
    });
  }
  return issues;
}

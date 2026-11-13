import { generateNKeysBetween } from "fractional-indexing";
import { PRIORITIES, STATUSES } from "../src/domain/model.ts";

export type SeedIssue = {
  id: string;
  title: string;
  description: string;
  status: (typeof STATUSES)[number];
  priority: (typeof PRIORITIES)[number];
  kanbanorder: string;
  username: string;
  created: number;
  modified: number;
};

export type SeedComment = { id: string; issue_id: string; body: string; username: string; created: number };

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

export function generate(count: number, seed = 1): { issues: SeedIssue[]; comments: SeedComment[] } {
  const r = rng(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
  const words = (lo: number, hi: number) => Array.from({ length: int(lo, hi) }, () => pick(WORDS)).join(" ");
  const sentence = (lo: number, hi: number) => {
    const s = words(lo, hi);
    return s[0]!.toUpperCase() + s.slice(1) + ".";
  };
  const uuid = () => {
    const h = Array.from({ length: 32 }, () => Math.floor(r() * 16).toString(16)).join("");
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
  };

  const keys = generateNKeysBetween(null, null, count);
  for (let i = keys.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [keys[i], keys[j]] = [keys[j]!, keys[i]!];
  }

  const now = Date.UTC(2026, 10, 1);
  const year = 365 * 24 * 3600 * 1000;
  const issues: SeedIssue[] = [];
  const comments: SeedComment[] = [];
  for (let i = 0; i < count; i++) {
    const created = now - Math.floor(r() * year);
    const issue: SeedIssue = {
      id: uuid(),
      title: sentence(3, 8).slice(0, -1),
      description: Array.from({ length: int(2, 6) }, () => sentence(6, 16)).join("\n"),
      status: pick(STATUSES),
      priority: pick(PRIORITIES),
      kanbanorder: keys[i]!,
      username: pick(NAMES),
      created,
      modified: created + Math.floor(r() * (now - created)),
    };
    issues.push(issue);
    if (r() < 0.5) {
      comments.push({
        id: uuid(),
        issue_id: issue.id,
        body: Array.from({ length: int(3, 8) }, () => sentence(6, 16)).join(" "),
        username: pick(NAMES),
        created: created + Math.floor(r() * (now - created)),
      });
    }
  }
  return { issues, comments };
}

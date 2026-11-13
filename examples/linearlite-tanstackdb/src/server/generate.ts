import { generateNKeysBetween } from "fractional-indexing";
import { commentKey, type ServerRow } from "../domain/model.ts";
import type { Stream } from "../domain/stores.ts";

/** A seeded server: every stream's rows in version order, and the head, the last version. */
export type Generated = { readonly rows: { readonly [S in Stream]: readonly ServerRow<S>[] }; readonly head: number };

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

/**
 * The same `issues` and `seed` give the same rows. Versions go newest `modified` first, each issue followed by its body
 * and comments, so a first sync fills the default list from its first page.
 */
export function generate(issues: number, seed = 1): Generated {
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
  const code = () => int(0, 4) as 0 | 1 | 2 | 3 | 4;

  const keys = generateNKeysBetween(null, null, issues);
  for (let i = keys.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [keys[i], keys[j]] = [keys[j]!, keys[i]!];
  }

  const now = Date.UTC(2026, 10, 1);
  const year = 365 * 24 * 3600 * 1000;
  const threads: { issue: ServerRow<"issues">; body: ServerRow<"bodies">; comments: ServerRow<"comments">[] }[] = [];
  for (let i = 0; i < issues; i++) {
    const created = now - Math.floor(r() * year);
    const id = uuid();
    const title = sentence(3, 8).slice(0, -1);
    const description = Array.from({ length: int(2, 6) }, () => sentence(6, 16)).join("\n");
    const issue = { id, title, status: code(), priority: code(), kanbanorder: keys[i]!, username: pick(NAMES), created, modified: created + Math.floor(r() * (now - created)), deleted: false, version: 0 };
    const comments: ServerRow<"comments">[] = [];
    if (r() < 0.5) {
      const cid = uuid();
      const body = Array.from({ length: int(3, 8) }, () => sentence(6, 16)).join(" ");
      comments.push({ key: commentKey(id, cid), id: cid, issue_id: id, body, username: pick(NAMES), created: created + Math.floor(r() * (now - created)), deleted: false, version: 0 });
    }
    threads.push({ issue, body: { id, description, version: 0 }, comments });
  }

  const rows = { issues: [] as ServerRow<"issues">[], bodies: [] as ServerRow<"bodies">[], comments: [] as ServerRow<"comments">[] };
  let version = 0;
  for (const t of threads.sort((a, b) => b.issue.modified - a.issue.modified)) {
    rows.issues.push({ ...t.issue, version: ++version });
    rows.bodies.push({ ...t.body, version: ++version });
    for (const c of t.comments) rows.comments.push({ ...c, version: ++version });
  }
  return { rows, head: version };
}

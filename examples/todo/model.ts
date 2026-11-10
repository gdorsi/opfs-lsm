/**
 * Headless todo model: generation, filtering, and cursor paging.
 *
 * No DOM and no runtime dependency on the packages: the docstore types
 * (`Cursor`, `Page`) come in through type-only imports, which erase at build
 * time. The store is whatever matches `TodoStore` — the page passes a real
 * `Collection` from `openDocStore`, `node:test` passes the in-memory fake in
 * `model.test.ts`.
 */

import type { Cursor, Page } from "@opfs-lsm/docstore";

/** Rows per page in the example UI. */
export const PAGE_SIZE = 50;
/** Most rows per `table.putMany` when seeding. */
const GENERATE_CHUNK = 1000;

/** `titleSort` is derived: indexes read document fields, so a case-insensitive title order needs its own column. */
export type Todo = {
  id: string;
  title: string;
  done: boolean;
  createdAt: number;
  titleSort: string;
};

const SORTS = {
  newest: { index: "byCreated", reverse: true },
  oldest: { index: "byCreated" },
  title: { index: "byTitle" },
} as const;

/** The sort orders the UI exposes. */
export type SortKey = keyof typeof SORTS;

type Paging = { readonly limit: number; readonly after?: Cursor | undefined };

/**
 * The reads the model makes. `search` keeps entries where each word of
 * `match` occurs inside a title word. `store.ts` declares these indexes.
 */
export type TodoQuery =
  | ({ readonly index: "byCreated"; readonly reverse?: boolean } & Paging)
  | ({ readonly index: "byTitle" } & Paging)
  | ({ readonly index: "search"; readonly match: string; readonly reverse: true } & Paging);

/**
 * The part of a docstore `Collection<Todo>` the model uses. `next` is the
 * last entry of a page and `after` starts the next page past it.
 */
export interface TodoStore {
  put(doc: Todo): Promise<void>;
  putMany(docs: readonly Todo[]): Promise<void>;
  /** Read-modify-write one row in one transaction. */
  modify(id: string, fn: (doc: Todo) => Todo): Promise<Todo | undefined>;
  delete(id: string): Promise<boolean>;
  clear(): Promise<void>;
  query(q: TodoQuery): Promise<Page<Todo>>;
}

export type ReadPageOptions = {
  after?: Cursor;
  sort?: SortKey | (string & {});
  filter?: string;
  pageSize?: number;
};

export function createTodo(
  title: string,
  now = Date.now(),
  id: string = crypto.randomUUID(),
): Todo | null {
  const trimmed = title.trim();
  if (trimmed.length === 0) return null;
  return {
    id,
    title: trimmed,
    done: false,
    createdAt: now,
    titleSort: trimmed.toLowerCase(),
  };
}

/** Lowercased words of `text`, split on anything that isn't a letter or digit. */
export function wordsOf(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 0);
}

export function normalizeFilter(filter: string): string {
  return typeof filter === "string" ? filter.trim().toLowerCase() : "";
}

/**
 * One page in `sort` order, starting after `after` (the `next` from the
 * previous page), so pages neither skip nor repeat rows.
 *
 * With a filter, the page is a `search` query: todos where each filter word
 * occurs inside a title word, newest first, and `sort` doesn't apply.
 */
export async function readPage(
  table: TodoStore,
  options: ReadPageOptions = {},
): Promise<{ todos: Todo[]; next?: Cursor }> {
  const {
    after,
    sort = "newest",
    filter = "",
    pageSize = PAGE_SIZE,
  } = options;
  // `(string & {})` widens the union so any string type-checks; the runtime
  // check matches the JS contract and raises RangeError for unknown sorts.
  if (!Object.hasOwn(SORTS, sort)) {
    throw new RangeError(`unknown sort: ${sort}`);
  }
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new RangeError(`pageSize must be a positive integer: ${pageSize}`);
  }

  const normalized = normalizeFilter(filter);
  const paging = { limit: pageSize, after };
  const page =
    wordsOf(normalized).length > 0
      ? await table.query({ index: "search", match: normalized, reverse: true, ...paging })
      : await table.query({ ...SORTS[sort as SortKey], ...paging });
  return { todos: page.docs, next: page.next };
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return function next(): number {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function wordPicker(rng: () => number): () => string {
  let bag: string[] = [];
  return function pick(): string {
    if (bag.length === 0) {
      bag = WORDS.slice();
      for (let i = bag.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        const tmp = bag[i];
        bag[i] = bag[j];
        bag[j] = tmp;
      }
    }
    return bag.pop()!; // non-null: the bag is refilled when empty
  };
}

function titleFromPicker(pick: () => string, rng: () => number): string {
  const count = 2 + Math.floor(rng() * 4);
  const words: string[] = [];
  for (let i = 0; i < count; i++) words.push(pick());
  const first = words[0];
  words[0] = first.charAt(0).toUpperCase() + first.slice(1);
  return words.join(" ");
}

/**
 * Append `count` random todos in batches. `seed` makes the titles repeatable.
 * `onProgress(done, total)` runs after each batch.
 */
export async function generateTodos(
  table: TodoStore,
  count: number,
  options: {
    now?: number;
    seed?: number;
    chunkSize?: number;
    onProgress?: (done: number, total: number) => void;
  } = {},
): Promise<number> {
  const {
    now = Date.now(),
    seed = (Math.random() * 0x100000000) >>> 0,
    chunkSize = GENERATE_CHUNK,
    onProgress,
  } = options;
  const total = Math.max(0, Math.trunc(count));
  if (total === 0) return 0;
  if (!Number.isInteger(chunkSize) || chunkSize < 1) {
    throw new RangeError(`chunkSize must be a positive integer: ${chunkSize}`);
  }

  const rng = mulberry32(seed);
  const pick = wordPicker(rng);
  const runId = `${seed.toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
  const start = Math.max(0, now - total + 1);

  let rows: Todo[] = [];
  for (let i = 0; i < total; i++) {
    if (rows.length === chunkSize) {
      await table.putMany(rows);
      if (onProgress) onProgress(i, total);
      rows = [];
    }
    rows.push(createTodo(titleFromPicker(pick, rng), start + i, `${runId}-${i.toString(36)}`)!);
  }
  await table.putMany(rows);
  if (onProgress) onProgress(total, total);
  return total;
}

/** Delete every todo. */
export function clearTodos(table: TodoStore): Promise<void> {
  return table.clear();
}

/** Flip `done` in one read-modify-write; indexes do not change. */
export async function toggleTodo(table: TodoStore, todo: Todo): Promise<void> {
  await table.modify(todo.id, (current) => ({
    ...current,
    done: !current.done,
  }));
}

export function deleteTodo(table: TodoStore, todo: Todo): Promise<boolean> {
  return table.delete(todo.id);
}

const WORDS: string[] = [
  "amber", "anchor", "apron", "arrow", "atlas", "autumn", "bacon", "badge",
  "baker", "bamboo", "barrel", "basin", "beacon", "beetle", "bishop", "blanket",
  "blossom", "border", "bottle", "boulder", "bracket", "breeze", "bridge",
  "bronze", "bubble", "bucket", "buffalo", "bundle", "butter", "button",
  "cabin", "cactus", "camera", "candle", "canoe", "canvas", "canyon", "carbon",
  "carpet", "castle", "cedar", "cello", "cement", "cherry", "chimney", "cider",
  "cinema", "circle", "citrus", "clover", "cobalt", "coffee", "collar", "comet",
  "compass", "copper", "coral", "cotton", "crayon", "cricket", "crystal",
  "cymbal", "daisy", "dapper", "decoy", "delta", "denim", "diesel", "dinner",
  "dolphin", "domino", "donut", "dragon", "drift", "dynamo", "eagle", "echo",
  "ember", "emerald", "engine", "fabric", "falcon", "feather", "fennel",
  "ferry", "fiddle", "figure", "filter", "finch", "fjord", "flannel", "flint",
  "forest", "fossil", "fountain", "gadget", "garden", "garlic", "gauge",
  "gecko", "ginger", "giraffe", "glacier", "glider", "granite", "grape",
  "grotto", "guitar", "gypsum", "hammer", "harbor", "hazel", "helmet",
  "hickory", "hollow", "honey", "hornet", "hunter", "igloo", "indigo",
  "island", "ivory", "jacket", "jaguar", "jasmine", "jelly", "jersey", "jewel",
  "jigsaw", "jungle", "junior", "kayak", "kettle", "kitten", "koala", "ladder",
  "lagoon", "lantern", "lattice", "lemon", "lentil", "lilac", "linen", "lizard",
  "lobster", "locket", "lotus", "lumber", "magnet", "mango", "maple", "marble",
  "meadow", "melody", "mentor", "mermaid", "meteor", "mitten", "monsoon",
  "moose", "mosaic", "moss", "muffin", "mustard", "nectar", "nickel", "noodle",
  "north", "nutmeg", "oasis", "ocean", "ocher", "olive", "onyx", "opal",
  "orbit", "orchid", "osprey", "otter", "outpost", "oyster", "paddle", "palace",
  "pamper", "panda", "papaya", "parrot", "pastel", "pebble", "pelican",
  "penguin", "pepper", "petal", "pewter", "piano", "pigeon", "pillar", "pine",
  "pixel", "plaza", "plum", "pocket", "pollen", "poplar", "poppy", "prairie",
  "prism", "puddle", "puffin", "pumpkin", "puzzle", "quartz", "quill", "quiver",
  "rabbit", "radish", "rafter", "rainbow", "rally", "raven", "ribbon", "ridge",
  "river", "robin", "rocket", "rodeo", "rosemary", "ruby", "rudder", "saddle",
  "saffron", "salmon", "sandal", "sapphire", "satchel", "scarf", "scooter",
  "shadow", "shelter", "sherbet", "shrimp", "silver", "sketch", "slate",
  "sleigh", "slope", "snow", "socket", "sonnet", "sparrow", "spice", "spiral",
  "spruce", "squash", "squirrel", "stable", "statue", "stellar", "stone",
  "storm", "suede", "summit", "sunset", "syrup", "tablet", "tandem", "tangle",
  "teapot", "temple", "tender", "thistle", "thunder", "tiger", "timber",
  "toffee", "tomato", "topaz", "torch", "tortoise", "totem", "toucan", "tower",
  "tractor", "trail", "trumpet", "tundra", "tunnel", "turkey", "turnip",
  "turtle", "umbrella", "unicorn", "valley", "vanilla", "velvet", "vessel",
  "violet", "violin", "voyage", "walnut", "wander", "wasabi", "water",
  "weasel", "whale", "wheat", "willow", "window", "winter", "wizard", "wombat",
  "wonder", "yarrow", "yogurt", "zebra", "zephyr", "zigzag", "zinc",
];

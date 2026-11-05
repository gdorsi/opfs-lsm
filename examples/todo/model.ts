/**
 * Headless todo model: schema, generation, filtering, and cursor paging.
 *
 * No DOM and no runtime dependency on the packages: the collections types
 * (`CollectionSchema`, `Table`) come in through type-only imports, which
 * erase at build time. The store is whatever matches `TodoStore` — the page
 * passes a real `Table` from `openCollectionDb`, `node:test` passes the
 * in-memory fake in `model.test.ts`.
 */

import type { CollectionSchema, Table } from "@opfs-lsm/collections";

/** Latest creation time the 15-digit derived rank supports. */
const MAX_TIME = 10 ** 15 - 1;

/** Rows per page in the example UI. */
export const PAGE_SIZE = 50;
/** Most rows per `table.putMany` when seeding. */
export const GENERATE_CHUNK = 1000;
/**
 * kv's ops per batch. A new todo writes its row, three sort index keys and
 * one key per search term, so seeding cuts batches by ops, not rows.
 */
export const MAX_BATCH_OPS = 10_000;
const opsFor = (todo: Todo) => 4 + todo.terms.length;
/** Search terms are word prefixes up to this length. Longer words match on their first 12 letters, then on the title. */
export const MAX_TERM_LENGTH = 12;
/** Words of a title that get search terms, so a long title stays under collections' keys-per-row limit. */
export const MAX_TERM_WORDS = 40;

export type Todo = {
  id: string;
  title: string;
  done: boolean;
  createdAt: number;
  newest: number;
  titleSort: string;
  /** Every prefix of every title word, lowercased, for `byTermNewest`. */
  terms: string[];
};

/**
 * `newest`, `titleSort` and `terms` are derived fields: collections indexes
 * read plain document fields, so each sort needs its own comparable column.
 * `byTermNewest` is multi-entry: it keys a todo once per term, newest first,
 * so a search reads only the todos that match.
 */
export const TODO_SCHEMA: CollectionSchema = {
  tables: [
    {
      name: "todos",
      primaryKey: "id",
      indexes: [
        { name: "byNewest", path: "newest" },
        { name: "byOldest", path: "createdAt" },
        { name: "byTitle", path: "titleSort" },
        { name: "byTermNewest", path: ["terms", "newest"], multiEntry: true },
      ],
    },
  ],
};

const SORTS = {
  newest: "byNewest",
  oldest: "byOldest",
  title: "byTitle",
} as const;

/** The sort orders the UI exposes. */
export type SortKey = keyof typeof SORTS;

/**
 * A page of index rows plus an opaque cursor. The real collections `Table`
 * fills it with `Uint8Array` index keys; the test fake uses row ids.
 */
export interface TodoStore<Cursor = unknown> {
  put(doc: Todo): Promise<string>;
  putMany(docs: readonly Todo[]): Promise<void>;
  /** Read-modify-write one row in one transaction. */
  update(id: string, mutate: (doc: Todo) => Todo): Promise<Todo | undefined>;
  delete(id: string): Promise<boolean>;
  clear(): Promise<number>;
  page(
    indexName: string,
    opts: { readonly after?: Cursor; readonly limit: number; readonly value?: string },
  ): Promise<{ readonly docs: readonly Todo[]; readonly next?: Cursor }>;
}

export type ReadPageOptions<Cursor> = {
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
    newest: MAX_TIME - now,
    titleSort: trimmed.toLowerCase(),
    terms: searchTerms(trimmed),
  };
}

/** Lowercased words of `text`, split on anything that isn't a letter or digit. */
export function wordsOf(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 0);
}

/** Each prefix of each word, up to `MAX_TERM_LENGTH` letters, so typing "mil" finds "milk". */
export function searchTerms(title: string): string[] {
  const out = new Set<string>();
  for (const word of wordsOf(title).slice(0, MAX_TERM_WORDS)) {
    for (let i = 1; i <= Math.min(word.length, MAX_TERM_LENGTH); i++) out.add(word.slice(0, i));
  }
  return [...out];
}

export function normalizeFilter(filter: string): string {
  return typeof filter === "string" ? filter.trim().toLowerCase() : "";
}

/** Every word of the filter starts some word of the title, ignoring case. */
export function matchesFilter(todo: { title: string }, normalized: string): boolean {
  const wanted = wordsOf(normalized);
  if (wanted.length === 0) return true;
  const words = wordsOf(todo.title);
  return wanted.every((w) => words.some((t) => t.startsWith(w)));
}

/**
 * One page in `sort` order, starting at `after` (the `next` from the previous
 * page). A chunk is at most one page, so filling the page always lands exactly
 * on a chunk boundary and `next` never skips an unconsumed row.
 *
 * With a filter, the page reads `byTermNewest` for the filter's longest word,
 * so it touches only todos with a word starting that way, newest first, and
 * `sort` doesn't apply. The other filter words are checked on each todo.
 */
export async function readPage<Cursor>(
  table: TodoStore<Cursor>,
  options: ReadPageOptions<Cursor> = {},
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
  const term = wordsOf(normalized)
    .reduce((a, b) => (b.length > a.length ? b : a), "")
    .slice(0, MAX_TERM_LENGTH);
  const index = term ? "byTermNewest" : SORTS[sort as SortKey];
  const todos: Todo[] = [];
  let cursor = after;

  for (;;) {
    const page = await table.page(index, {
      ...(cursor !== undefined ? { after: cursor } : {}),
      ...(term ? { value: term } : {}),
      limit: pageSize,
    });
    for (const todo of page.docs) {
      if (matchesFilter(todo, normalized)) todos.push(todo);
    }
    if (todos.length >= pageSize) return { todos, next: page.next };
    if (page.next === undefined) return { todos, next: undefined };
    cursor = page.next;
  }
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

/** 2 to 5 random words, first one capitalized. */
export function randomTitle(rng: () => number): string {
  return titleFromPicker(wordPicker(rng), rng);
}

/**
 * Append `count` random todos in batches. `seed` makes the titles repeatable.
 * `onProgress(done, total)` runs after each batch.
 */
export async function generateTodos<Cursor>(
  table: TodoStore<Cursor>,
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
  let ops = 0;
  for (let i = 0; i < total; i++) {
    const todo = createTodo(titleFromPicker(pick, rng), start + i, `${runId}-${i.toString(36)}`)!;
    if (rows.length === chunkSize || ops + opsFor(todo) > MAX_BATCH_OPS) {
      await table.putMany(rows);
      if (onProgress) onProgress(i, total);
      rows = [];
      ops = 0;
    }
    rows.push(todo);
    ops += opsFor(todo);
  }
  await table.putMany(rows);
  if (onProgress) onProgress(total, total);
  return total;
}

/** Delete every todo. Returns the number of rows deleted. */
export function clearTodos<Cursor>(table: TodoStore<Cursor>): Promise<number> {
  return table.clear();
}

/** Flip `done` in one read-modify-write; indexes do not change. */
export async function toggleTodo<Cursor>(
  table: TodoStore<Cursor>,
  todo: Todo,
): Promise<void> {
  await table.update(todo.id, (current) => ({
    ...current,
    done: !current.done,
  }));
}

export function deleteTodo<Cursor>(
  table: TodoStore<Cursor>,
  todo: Todo,
): Promise<boolean> {
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

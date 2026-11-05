/**
 * Headless todo model: schema, generation, filtering, and cursor paging.
 *
 * No DOM. The store is an `@opfs-lsm/collections` `Table` (or anything with
 * the same `put` / `putMany` / `update` / `delete` / `clear` / `page` shape),
 * so `main.js` passes the real table and `node --test` passes a fake.
 */

/** Latest creation time the 15-digit derived rank supports. */
const MAX_TIME = 10 ** 15 - 1;

/** Rows per page in the example UI. */
export const PAGE_SIZE = 50;
/** Rows per `table.putMany` when seeding. */
export const GENERATE_CHUNK = 1000;

/**
 * `newest` and `titleSort` are derived fields: collections indexes read plain
 * document fields, so each sort needs its own comparable column.
 */
export const TODO_SCHEMA = {
  tables: [
    {
      name: "todos",
      primaryKey: "id",
      indexes: [
        { name: "byNewest", path: "newest" },
        { name: "byOldest", path: "createdAt" },
        { name: "byTitle", path: "titleSort" },
      ],
    },
  ],
};

const SORTS = {
  newest: "byNewest",
  oldest: "byOldest",
  title: "byTitle",
};

const WORDS = [
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

export function createTodo(title, now = Date.now(), id = crypto.randomUUID()) {
  const trimmed = title.trim();
  if (trimmed.length === 0) return null;
  return {
    id,
    title: trimmed,
    done: false,
    createdAt: now,
    newest: MAX_TIME - now,
    titleSort: trimmed.toLowerCase(),
  };
}

export function normalizeFilter(filter) {
  return typeof filter === "string" ? filter.trim().toLowerCase() : "";
}

export function matchesFilter(todo, normalized) {
  if (normalized.length === 0) return true;
  return todo.title.toLowerCase().includes(normalized);
}

/**
 * One page in `sort` order, starting at `after` (the `next` from the previous
 * page). A chunk is at most one page, so filling the page always lands exactly
 * on a chunk boundary and `next` never skips an unconsumed row.
 */
export async function readPage(table, options = {}) {
  const {
    after,
    sort = "newest",
    filter = "",
    pageSize = PAGE_SIZE,
  } = options;
  if (!Object.hasOwn(SORTS, sort)) {
    throw new RangeError(`unknown sort: ${sort}`);
  }
  if (!Number.isInteger(pageSize) || pageSize < 1) {
    throw new RangeError(`pageSize must be a positive integer: ${pageSize}`);
  }

  const index = SORTS[sort];
  const normalized = normalizeFilter(filter);
  const todos = [];
  let cursor = after;

  for (;;) {
    const page = await table.page(index, {
      ...(cursor !== undefined ? { after: cursor } : {}),
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

function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function wordPicker(rng) {
  let bag = [];
  return function pick() {
    if (bag.length === 0) {
      bag = WORDS.slice();
      for (let i = bag.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        const tmp = bag[i];
        bag[i] = bag[j];
        bag[j] = tmp;
      }
    }
    return bag.pop();
  };
}

function titleFromPicker(pick, rng) {
  const count = 2 + Math.floor(rng() * 4);
  const words = [];
  for (let i = 0; i < count; i++) words.push(pick());
  const first = words[0];
  words[0] = first.charAt(0).toUpperCase() + first.slice(1);
  return words.join(" ");
}

/** 2 to 5 random words, first one capitalized. */
export function randomTitle(rng) {
  return titleFromPicker(wordPicker(rng), rng);
}

/**
 * Append `count` random todos in batches. `seed` makes the titles repeatable.
 * `onProgress(done, total)` runs after each batch.
 */
export async function generateTodos(table, count, options = {}) {
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

  for (let done = 0; done < total; done += chunkSize) {
    const end = Math.min(total, done + chunkSize);
    const rows = [];
    for (let i = done; i < end; i++) {
      rows.push(
        createTodo(
          titleFromPicker(pick, rng),
          start + i,
          `${runId}-${i.toString(36)}`,
        ),
      );
    }
    await table.putMany(rows);
    if (onProgress) onProgress(end, total);
  }
  return total;
}

/** Delete every todo. Returns the number of rows deleted. */
export function clearTodos(table) {
  return table.clear();
}

/** Flip `done` in one read-modify-write; indexes do not change. */
export async function toggleTodo(table, todo) {
  await table.update(todo.id, (current) => ({
    ...current,
    done: !current.done,
  }));
}

export function deleteTodo(table, todo) {
  return table.delete(todo.id);
}

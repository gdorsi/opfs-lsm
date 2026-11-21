import { defineWorkload, type PhaseContext } from "../../core/types.ts";
import { permutation } from "../../page/model.ts";
import { fillPhase, kvParams, settlePhase } from "../kv-lib.ts";

/** The keys one read asks for. */
const PAGE = 500;

type Ctx = PhaseContext<"kv">;

/** Reads every value in reads of `PAGE` keys, `ids` giving the order, and checks each one after the last read. */
async function readAll(ctx: Ctx, ids: Uint32Array): Promise<void> {
  const pages: { ids: Uint32Array; keys: Uint8Array[] }[] = [];
  for (let i = 0; i < ids.length; i += PAGE) {
    const page = ids.subarray(i, i + PAGE);
    pages.push({ ids: page, keys: Array.from(page, (id) => ctx.model.key(id)) });
  }
  const store = await ctx.store();
  const got: (Uint8Array | undefined)[][] = [];
  for (const { keys } of pages) got.push(await ctx.time("getMany", 0, () => store.getMany(keys), keys.length));
  pages.forEach((page, i) => page.ids.forEach((id, j) => ctx.model.verify(id, got[i]![j])));
}

/**
 * A store of 8 KiB values, as a sync client keeps its state in chunks, under
 * keys that share all but their last 4 bytes. A fresh tab reads every value
 * in reads of `PAGE` keys. `readall-cold` asks for neighbouring keys in each
 * read, as such a client loads the children of one tree node at startup.
 * `readscattered-cold` asks for keys from all over the store in each read.
 */
export default defineWorkload({
  family: "kv",
  title: "random fill of 8 KiB values, then every value read in bulk in a fresh tab, by neighbouring and by scattered keys",
  owns: ["kv-large-values"],
  params: (size) => {
    const entries = { tiny: 200, small: 6_000, large: 24_000 }[size];
    return kvParams(size, { entries, keyBytes: 40, valueBytes: 8 * 1024, batch: 200, ops: entries });
  },
  phases: [
    fillPhase("fill", "random"),
    settlePhase(),
    {
      name: "readall-cold",
      page: "fresh",
      rounds: 5,
      timed: true,
      async run(ctx) {
        const { entries } = ctx.params;
        const starts = permutation(Math.ceil(entries / PAGE), ctx.rng);
        const ids = new Uint32Array(entries);
        let n = 0;
        for (const start of starts) for (let id = start * PAGE; id < Math.min(entries, (start + 1) * PAGE); id++) ids[n++] = id;
        await readAll(ctx, ids);
      },
    },
    {
      name: "readscattered-cold",
      page: "fresh",
      rounds: 5,
      timed: true,
      run: (ctx) => readAll(ctx, permutation(ctx.params.entries, ctx.rng)),
    },
  ],
});

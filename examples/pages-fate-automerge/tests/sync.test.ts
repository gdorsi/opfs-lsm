import { Repo } from "@automerge/automerge-repo";
import { BroadcastChannelNetworkAdapter } from "@automerge/automerge-repo-network-broadcastchannel";
import { MessageChannelNetworkAdapter } from "@automerge/automerge-repo-network-messagechannel";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { isDeepStrictEqual } from "node:util";
import { newPageId, openBodies, type Bodies } from "../src/model/bodies.ts";
import type { PageBody, Span, TextEdit } from "../src/model/types.ts";
import { memoryBodies } from "../src/storage/memory.ts";
import { random, randomBatch } from "../src/testing/random-edits.ts";
import { referenceBody } from "../src/testing/reference.ts";

function twoPeers(): { a: Bodies; b: Bodies; close(): Promise<void> } {
  const { port1, port2 } = new MessageChannel();
  const a = openBodies({ storage: memoryBodies(), network: [new MessageChannelNetworkAdapter(port1)] });
  const b = openBodies({ storage: memoryBodies(), network: [new MessageChannelNetworkAdapter(port2)] });
  return {
    a,
    b,
    async close() {
      await Promise.all([a.close(), b.close()]);
      port1.close();
      port2.close();
    },
  };
}

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const text = (spans: readonly Span[]) => spans.map((span) => (span.type === "text" ? span.text : "¶")).join("");
const same = (a: PageBody, b: PageBody) => isDeepStrictEqual(a.spans(), b.spans());

test("two Repos that each seed the same id merge, keeping both sides' text", async (t) => {
  const peers = twoPeers();
  t.after(() => peers.close());
  const id = newPageId();
  const [a, b] = await Promise.all([peers.a.open(id), peers.b.open(id)]);
  a.edit([{ type: "insert", at: 1, text: "from A", marks: {} }]);
  b.edit([{ type: "insert", at: 1, text: "from B", marks: { bold: true } }]);
  assert.equal(text(a.spans()), "¶from A", "A seeded on its own");
  assert.equal(text(b.spans()), "¶from B", "B seeded on its own");

  await until(() => same(a, b), "the two copies to converge");
  const merged = text(a.spans());
  assert.ok(merged.includes("from A") && merged.includes("from B"), `both sides survive: ${merged}`);
  assert.equal(merged.length, "¶from Afrom B".length);
});

test("subscribe delivers remote edits as TextEdits that rebuild the spans, while both peers type", async (t) => {
  const peers = twoPeers();
  t.after(() => peers.close());
  const id = newPageId();
  const sides = (await Promise.all([peers.a.open(id), peers.b.open(id)])).map((body, i) => {
    const mirror = referenceBody();
    const side = { body, mirror, rand: random(7 + i), deliveries: [] as (readonly TextEdit[])[] };
    body.subscribe((edits) => {
      side.deliveries.push(edits);
      mirror.edit(edits);
    });
    return side;
  });

  for (let round = 1; round <= 40; round++) {
    for (const side of sides) {
      for (let i = 0; i < 1 + Math.floor(side.rand() * 15); i++) side.body.edit(randomBatch(side.rand, side.mirror));
    }
    await new Promise((resolve) => setTimeout(resolve, 1 + (round % 4) * 3));
    for (const side of sides) assert.deepEqual(side.mirror.spans(), side.body.spans(), `round ${round}: local edits plus deliveries rebuild the spans`);
  }
  const [a, b] = sides as [(typeof sides)[0], (typeof sides)[0]];
  await until(() => same(a.body, b.body), "the peers to converge");
  assert.deepEqual(a.mirror.spans(), a.body.spans());
  assert.deepEqual(b.mirror.spans(), b.body.spans());

  const delivered = sides.flatMap((side) => side.deliveries);
  const kinds = new Set(delivered.flat().map((edit) => edit.type));
  t.diagnostic(`${delivered.length} deliveries, ${delivered.flat().length} edits, kinds: ${[...kinds].sort().join(", ")}`);
  for (const kind of ["insert", "delete", "split", "mark"]) assert.ok(kinds.has(kind as TextEdit["type"]), `a ${kind} was delivered`);

  const before = a.deliveries.length;
  a.body.edit([{ type: "insert", at: 1, text: "local", marks: {} }]);
  await until(() => text(b.body.spans()).startsWith("¶local"), "B to see A's edit");
  assert.equal(a.deliveries.length, before, "A's own edit is not echoed to A");
});

test("open of an unknown id does not wait on an attached network adapter", async (t) => {
  const channelName = `pages-${randomUUID()}`;
  const bodies = openBodies({
    storage: memoryBodies(),
    network: [new BroadcastChannelNetworkAdapter({ channelName })],
  });
  const openMs: number[] = [];
  for (let i = 0; i < 5; i++) {
    const started = performance.now();
    const body = await bodies.open(newPageId());
    openMs.push(performance.now() - started);
    assert.equal(text(body.spans()), "¶", "an unknown id opens as the seed");
  }
  await bodies.close();

  const repo = new Repo({ storage: memoryBodies(), network: [new BroadcastChannelNetworkAdapter({ channelName })] });
  const started = performance.now();
  await repo.find(newPageId()).catch(() => {});
  const findMs = performance.now() - started;
  await repo.shutdown();

  t.diagnostic(`open ms: ${openMs.map((ms) => ms.toFixed(1)).join(", ")}; repo.find on the same adapter: ${findMs.toFixed(0)} ms`);
  assert.ok(Math.max(...openMs) < 100, `open took ${Math.max(...openMs).toFixed(1)} ms`);
  assert.ok(findMs >= 500, "the adapter does hold back a plain find, so the open measured above skipped a real wait");
});

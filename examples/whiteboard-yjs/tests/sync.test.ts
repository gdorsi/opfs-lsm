import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { openBoard } from "../src/model/board.ts";
import { applyPatchPlain, digestShapes } from "../src/model/digest.ts";
import { boardId } from "../src/model/shapes.ts";
import { broadcastSync, type ChannelConstructor } from "../src/model/sync.ts";
import type { Applied, Board, NewShape, Shape, ShapeId } from "../src/model/types.ts";
import { memoryStorage } from "../src/persistence/index.ts";
import { idCounter, testEnv } from "./support/env.ts";

const id = boardId("r");
const CHANNEL = "whiteboard-yjs/board/r";
const rect = (x = 0, y = 0): NewShape => ({ kind: "rect", x, y, w: 10, h: 10, stroke: "#000", fill: null, strokeWidth: 2 });

/** Node's BroadcastChannel, counting what is posted and which channels are still open. */
function spyChannel() {
  const log = { posted: [] as unknown[], open: 0 };
  class Spy extends BroadcastChannel {
    constructor(name: string) {
      super(name);
      log.open++;
    }
    override postMessage(message: unknown): void {
      log.posted.push(message);
      super.postMessage(message);
    }
    override close(): void {
      log.open--;
      super.close();
    }
  }
  return { log, Channel: Spy };
}

/**
 * Message delivery between BroadcastChannels is asynchronous. Yielding to the event loop is how a test waits for it:
 * no timer, no clock, and a bound so a failure is a failure instead of a hang.
 */
async function until(done: () => boolean, what: string): Promise<void> {
  for (let turns = 0; turns < 5000; turns++) {
    if (done()) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail(`never happened: ${what}`);
}

/** A tab: its own storage, so only the relay can bring it another tab's edits. */
async function tab(name: string, Channel: ChannelConstructor = BroadcastChannel) {
  const storage = memoryStorage();
  const board = await openBoard({ id, storage, env: testEnv(idCounter(name)), autosaveMs: null, gestureIntervalMs: 0, sync: broadcastSync(Channel) });
  return { storage, board };
}

/** The oracle: every patch every tab got back, replayed on a plain Map. */
class Oracle {
  readonly shapes = new Map<ShapeId, Shape>();
  apply(applied: Applied): Applied {
    applyPatchPlain(this.shapes, applied.patch);
    return applied;
  }
  get digest(): string {
    return digestShapes(this.shapes);
  }
}

const digestOf = (board: Board) => digestShapes(board.view().shapes);
const open: Board[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((board) => board.close()));
});
const track = <T extends { board: Board }>(t: T): T => {
  open.push(t.board);
  return t;
};

describe("two tabs over BroadcastChannel", () => {
  test("converge on the oracle, and undo reverts only the tab's own steps", async () => {
    const a = track(await tab("a"));
    const b = track(await tab("b"));
    const oracle = new Oracle();

    const mine = oracle.apply(a.board.dispatch({ type: "create", shapes: [rect(0, 0), rect(100, 0), rect(200, 0)] })).created;
    const theirs = oracle.apply(b.board.dispatch({ type: "create", shapes: [rect(0, 100), rect(100, 100)] })).created;
    const drag = a.board.beginGesture({ kind: "translate", ids: [mine[0]!] });
    for (let i = 1; i <= 20; i++) drag.update({ dx: i * 2, dy: i }, i * 8);
    oracle.apply(drag.end());
    oracle.apply(b.board.dispatch({ type: "style", ids: theirs, edit: { stroke: "#f00" } }));
    oracle.apply(a.board.dispatch({ type: "remove", ids: [mine[2]!] }));

    await until(() => digestOf(a.board) === oracle.digest && digestOf(b.board) === oracle.digest, "both tabs reach the oracle");
    assert.equal(a.board.view().shapes.size, 4);

    while (a.board.undo());
    oracle.shapes.clear();
    for (const shape of b.board.view().shapes.values()) if (theirs.includes(shape.id)) oracle.shapes.set(shape.id, shape);
    await until(() => digestOf(a.board) === oracle.digest && digestOf(b.board) === oracle.digest, "a's undo reaches b");
    assert.deepEqual([...b.board.view().order], theirs, "b's own shapes are all that is left");
  });

  test("a tab that opens late gets the diff and holds what it received in its own storage", async () => {
    const a = track(await tab("a"));
    const b = track(await tab("b"));
    const oracle = new Oracle();
    const made = oracle.apply(a.board.dispatch({ type: "create", shapes: Array.from({ length: 30 }, (_, i) => rect(i, i)) })).created;
    oracle.apply(b.board.dispatch({ type: "move", ids: made.slice(0, 5), dx: 7, dy: 7 }));
    await until(() => digestOf(a.board) === oracle.digest, "a sees b's move");

    const late = track(await tab("c"));
    assert.equal(late.board.view().shapes.size, 0, "it opened with nothing");
    await until(() => digestOf(late.board) === oracle.digest, "the late tab reaches the oracle");

    const alone = await openBoard({ id, storage: late.storage, env: testEnv(idCounter("x")), autosaveMs: null });
    assert.equal(digestOf(alone), oracle.digest, "what the relay brought was stored, so a reload without the relay has it");
  });

  test("an update the relay applied is not posted back", async () => {
    const { log, Channel } = spyChannel();
    const a = track(await tab("a", Channel));
    const b = track(await tab("b", Channel));
    await until(() => log.posted.length >= 3, "both hellos and the answers");
    await new Promise<void>((resolve) => setImmediate(resolve));
    log.posted.length = 0;

    a.board.dispatch({ type: "create", shapes: [rect()] });
    await until(() => b.board.view().shapes.size === 1, "b receives it");
    for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(log.posted.length, 1, "one post: a's update, and nothing from b");
  });

  test("bytes that are not an update are ignored, and the relay keeps working", async () => {
    const a = track(await tab("a"));
    const b = track(await tab("b"));
    const stranger = new BroadcastChannel(CHANNEL);
    stranger.postMessage("junk");
    stranger.postMessage(null);
    stranger.postMessage({ type: "update" });
    stranger.postMessage({ type: "update", update: new Uint8Array([9, 9, 9, 9]) });
    stranger.postMessage({ type: "hello", stateVector: new Uint8Array([255, 255, 255]) });
    stranger.postMessage({ type: "unknown", update: new Uint8Array() });
    a.board.dispatch({ type: "create", shapes: [rect()] });
    await until(() => b.board.view().shapes.size === 1, "b still receives a's update");
    stranger.close();
    assert.equal(a.board.view().skipped + b.board.view().skipped, 0);
  });

  test("closing a board closes its channel", async () => {
    const { log, Channel } = spyChannel();
    const a = await tab("a", Channel);
    assert.equal(log.open, 1);
    await a.board.close();
    assert.equal(log.open, 0);
  });

  test("a board with no relay opens no channel", async () => {
    const { log } = spyChannel();
    const board = await openBoard({ id, storage: memoryStorage(), env: testEnv(idCounter("a")), autosaveMs: null });
    board.dispatch({ type: "create", shapes: [rect()] });
    assert.deepEqual([log.open, log.posted.length], [0, 0]);
    await board.close();
  });
});

describe("the relay does not depend on storage", () => {
  test("the answer to a hello carries what the asker lacks and nothing else", async () => {
    const Y = await import("yjs");
    const { log, Channel } = spyChannel();
    const sync = broadcastSync(Channel);
    const [one, two] = [new Y.Doc(), new Y.Doc()];
    one.transact(() => {
      for (let i = 0; i < 500; i++) one.getMap("m").set(`key${i}`, "x".repeat(40));
    });
    Y.applyUpdate(two, Y.encodeStateAsUpdate(one));
    one.getMap("m").set("extra", 1);
    const whole = Y.encodeStateAsUpdate(one).byteLength;
    const stopOne = sync("diff", one);
    log.posted.length = 0;
    const stopTwo = sync("diff", two);
    try {
      await until(() => two.getMap("m").get("extra") === 1, "the asker gets what it lacked");
      const answers = log.posted.flatMap((m) => ((m as { update?: Uint8Array }).update ? [(m as { update: Uint8Array }).update] : []));
      assert.equal(answers.length, 1);
      assert.ok(answers[0]!.byteLength < whole / 50, `the answer is ${answers[0]!.byteLength} bytes of a ${whole} byte doc`);
    } finally {
      stopOne();
      stopTwo();
    }
  });

  test("with the channel as the only thing it is given, it moves a doc between two Y.Docs", async () => {
    const Y = await import("yjs");
    const sync = broadcastSync(BroadcastChannel);
    const [one, two] = [new Y.Doc(), new Y.Doc()];
    one.getMap("m").set("before", 1);
    const stopOne = sync("plain", one);
    const stopTwo = sync("plain", two);
    try {
      await until(() => two.getMap("m").get("before") === 1, "the late doc gets the diff");
      two.getMap("m").set("after", 2);
      await until(() => one.getMap("m").get("after") === 2, "the first doc gets the live update");
    } finally {
      stopOne();
      stopTwo();
    }
  });
});

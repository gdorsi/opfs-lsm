import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleBenchPost,
  runAttempts,
  sawNetworkCrash,
  type BenchAttempt,
  type Outcome,
} from "../scripts/bench-browser.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const CHROME_CRASH_LINE =
  "ERROR:content/browser/network_service_instance_impl.cc:610] Network service crashed or was terminated, restarting service.";

function fakeRes(): ServerResponse {
  return {
    writeHead() {
      return this;
    },
    end() {
      return this;
    },
  } as unknown as ServerResponse;
}

/** A POST whose body arrives only when the test says so. */
function heldPost(url: string): { req: IncomingMessage; finish: (body: string) => void } {
  const stream = new Readable({
    read() {
      /* push happens from the test */
    },
  });
  const req = Object.assign(stream, { method: "POST", url }) as IncomingMessage;
  return {
    req,
    finish(body: string) {
      stream.push(Buffer.from(body));
      stream.push(null);
    },
  };
}

function attempt(): { current: BenchAttempt; taken: () => Outcome | null } {
  let hit: Outcome | null = null;
  const current: BenchAttempt = {
    startedAt: Date.now(),
    trail: [],
    settle: (outcome) => {
      hit = outcome;
    },
  };
  return { current, taken: () => hit };
}

function scripted(outcomes: Outcome[]): {
  launch: () => Promise<{ outcome: Outcome; trail: string[]; stderr: string }>;
  calls: () => number;
} {
  let calls = 0;
  return {
    calls: () => calls,
    launch: async () => {
      calls += 1;
      const outcome = outcomes.shift();
      if (!outcome) throw new Error("unexpected extra launch");
      return {
        outcome,
        trail: [`+${calls}ms GET /bench/browser.html`],
        stderr: "chrome stderr",
      };
    },
  };
}

function captureConsole(): { logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  });
  return { logs, errors };
}

describe("bench browser launches", () => {
  it("detects Chrome's network-service crash line across a split stderr chunk", () => {
    expect(sawNetworkCrash(CHROME_CRASH_LINE)).toBe(true);
    const parts = [
      "ERROR Network service cra",
      "shed or was terminated, restarting service.\n",
    ];
    expect(sawNetworkCrash(parts[0] ?? "")).toBe(false);
    expect(sawNetworkCrash(parts.join(""))).toBe(true);
    expect(sawNetworkCrash("GPU process isn't usable")).toBe(false);
  });

  it("relaunches once after a network-service crash and then passes", async () => {
    const { logs, errors } = captureConsole();
    const run = scripted([
      { kind: "network-crash" },
      { kind: "result", body: JSON.stringify({ log: "kv point get (post-ingest) 1.0 ms" }) },
    ]);
    await expect(runAttempts(run.launch, 120_000)).resolves.toBe(0);
    expect(run.calls()).toBe(2);
    expect(logs.join("\n")).toContain("kv point get (post-ingest)");
    expect(errors.filter((line) => line.includes("Relaunching"))).toHaveLength(1);
  });

  it("stops after a second network-service crash", async () => {
    const { errors } = captureConsole();
    const run = scripted([{ kind: "network-crash" }, { kind: "network-crash" }]);
    await expect(runAttempts(run.launch, 120_000)).resolves.toBe(1);
    expect(run.calls()).toBe(2);
    expect(errors.filter((line) => line.includes("Relaunching"))).toHaveLength(1);
    expect(errors.join("\n")).toContain("attempt 2");
  });

  it("does not relaunch on a timeout, a Chrome exit, or a page error", async () => {
    const { errors } = captureConsole();
    const timeout = scripted([{ kind: "timeout" }]);
    await expect(runAttempts(timeout.launch, 120_000)).resolves.toBe(1);
    expect(timeout.calls()).toBe(1);

    const exited = scripted([{ kind: "chrome-exit", code: null, signal: "SIGKILL" }]);
    await expect(runAttempts(exited.launch, 120_000)).resolves.toBe(1);
    expect(exited.calls()).toBe(1);

    const pageError = scripted([
      { kind: "result", body: JSON.stringify({ error: "warm get missing k0" }) },
    ]);
    await expect(runAttempts(pageError.launch, 120_000)).resolves.toBe(1);
    expect(pageError.calls()).toBe(1);
    expect(errors.join("\n")).toContain("warm get missing k0");
    expect(errors.join("\n")).not.toContain("Relaunching");
  });

  it("fails a result that is not a JSON object without relaunching", async () => {
    const { errors } = captureConsole();
    const run = scripted([{ kind: "result", body: '{"log":' }]);
    await expect(runAttempts(run.launch, 120_000)).resolves.toBe(1);
    expect(run.calls()).toBe(1);
    expect(errors.join("\n")).toContain("not JSON");
  });

  it("keeps a late result on the launch that accepted the POST", async () => {
    const first = attempt();
    const second = attempt();
    let current: BenchAttempt | null = first.current;
    const { req, finish } = heldPost("/bench-results");
    const pending = handleBenchPost(req, fakeRes(), () => current);
    current = second.current;
    finish('{"log":"from the first launch"}');
    await pending;
    expect(first.taken()).toEqual({
      kind: "result",
      body: '{"log":"from the first launch"}',
    });
    expect(second.taken()).toBeNull();
  });

  it("ignores a truncated result so a crash can still relaunch", async () => {
    const first = attempt();
    const { req, finish } = heldPost("/bench-results");
    const pending = handleBenchPost(req, fakeRes(), () => first.current);
    finish('{"log":');
    await pending;
    expect(first.taken()).toBeNull();
  });

  it("keeps a late progress line on the launch that accepted it", async () => {
    const first = attempt();
    const second = attempt();
    let current: BenchAttempt | null = first.current;
    const { req, finish } = heldPost("/bench-progress");
    const pending = handleBenchPost(req, fakeRes(), () => current);
    current = second.current;
    finish("kv solitary put");
    await pending;
    expect(first.current.trail.join("\n")).toContain("page: kv solitary put");
    expect(second.current.trail).toEqual([]);
    expect(first.taken()).toBeNull();
  });
});

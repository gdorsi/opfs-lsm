import { openDb } from "@opfs-lsm/kv";
import { createLiveQueryCollection, eq } from "@tanstack/db";
import { openIndexedDbBackend } from "../backends/indexeddb.ts";
import { openKvBackend } from "../backends/kv.ts";
import type { Backend } from "../model/backend.ts";
import { openLinearlite, type Linearlite } from "../model/index.ts";
import { httpTransport } from "./transport.ts";

let opening: Promise<Linearlite> | undefined;
let opened: Linearlite | undefined;

/** The replica `?backend=` names: kv, the default, or `indexeddb`. */
async function openBackend(params: URLSearchParams): Promise<Backend & { readonly docs?: unknown }> {
  const name = params.get("db") ?? "linearlite";
  if (params.get("backend") === "indexeddb") {
    return openIndexedDbBackend(`${name}-indexeddb`, { hidden: () => document.hidden });
  }
  // `?maxBytes=` sets a byte cap, to see an eviction without filling the disk.
  const db = await openDb({ name, maxBytes: Number(params.get("maxBytes")) || "quota" });
  return openKvBackend(db, { hidden: () => document.hidden });
}

/**
 * This tab's model, over the database `?db=` names. Every tab asks for the `linearlite:sync` Web Lock and holds it
 * for its life, so one tab per browser leads sync and the next takes over when it closes.
 */
export function openApp(): Promise<Linearlite> {
  return (opening ??= (async () => {
    const params = new URLSearchParams(location.search);
    const backend = await openBackend(params);
    const model = openLinearlite({
      backend,
      transport: httpTransport(params.get("user") ?? "anonymous"),
      pullLimit: Number(params.get("pull")) || undefined,
      onCaughtUp: (stream) => performance.mark(`linearlite:caught-up:${stream}`),
    });
    void navigator.locks.request("linearlite:sync", () => {
      performance.mark("linearlite:leader");
      return model.sync.lead(new AbortController().signal);
    });
    // bench/client.ts drives edits through this, on production builds too.
    const store = { issues: backend.collection("issues"), docs: backend.docs };
    Object.assign(globalThis, { __linearlite: { store, commands: model.commands, createLiveQueryCollection, eq } });
    opened = model;
    return model;
  })());
}

export function model(): Linearlite {
  if (!opened) throw new Error("openApp() has not resolved yet");
  return opened;
}

import { openDb } from "@opfs-lsm/kv";
import { createLiveQueryCollection, eq } from "@tanstack/db";
import { openLinearlite, type Linearlite } from "../model/index.ts";
import { openStore } from "../model/store.ts";
import { httpTransport } from "./transport.ts";

let opening: Promise<Linearlite> | undefined;
let opened: Linearlite | undefined;

/**
 * This tab's model, over the database `?db=` names. Every tab asks for the `linearlite:sync` Web Lock and holds it
 * for its life, so one tab per browser leads sync and the next takes over when it closes.
 */
export function openApp(): Promise<Linearlite> {
  return (opening ??= (async () => {
    const params = new URLSearchParams(location.search);
    // `?maxBytes=` sets a byte cap, to see an eviction without filling the disk.
    const db = await openDb({ name: params.get("db") ?? "linearlite", maxBytes: Number(params.get("maxBytes")) || "quota" });
    const store = await openStore(db);
    const model = openLinearlite({
      store,
      transport: httpTransport(params.get("user") ?? "anonymous"),
      pullLimit: Number(params.get("pull")) || undefined,
      onCaughtUp: (stream) => performance.mark(`linearlite:caught-up:${stream}`),
      hidden: () => document.hidden,
    });
    void navigator.locks.request("linearlite:sync", () => {
      performance.mark("linearlite:leader");
      return model.sync.lead(new AbortController().signal);
    });
    // bench/client.ts drives edits through this, on production builds too.
    Object.assign(globalThis, { __linearlite: { store, commands: model.commands, createLiveQueryCollection, eq } });
    opened = model;
    return model;
  })());
}

export function model(): Linearlite {
  if (!opened) throw new Error("openApp() has not resolved yet");
  return opened;
}

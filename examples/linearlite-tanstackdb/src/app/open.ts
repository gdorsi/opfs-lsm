import { openDb } from "@opfs-lsm/kv";
import { openKvBackend } from "../backends/kv.ts";
import { openLinearlite, type Linearlite } from "../model/index.ts";
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
    const backend = await openKvBackend(db, { hidden: () => document.hidden });
    const model = openLinearlite({ backend, transport: httpTransport(params.get("user") ?? "anonymous") });
    void navigator.locks.request("linearlite:sync", () => model.sync.lead(new AbortController().signal));
    opened = model;
    return model;
  })());
}

export function model(): Linearlite {
  if (!opened) throw new Error("openApp() has not resolved yet");
  return opened;
}

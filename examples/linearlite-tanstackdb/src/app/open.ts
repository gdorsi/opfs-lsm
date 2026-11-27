import { destroyDb, openDb } from "@opfs-lsm/kv";
import { openKvBackend } from "../backends/kv.ts";
import { openLinearlite, type Linearlite } from "../model/index.ts";
import { httpTransport } from "./transport.ts";

/**
 * The version of the data this app stores, in its database name. Raise it in any change that makes data written before
 * it read differently: a kv or docstore format, or this app's schema. A visitor then syncs into a fresh database.
 */
const DATA_VERSION = 7;
const DEFAULT_NAME = `linearlite-v${DATA_VERSION}`;
/** The databases earlier builds synced into. `destroyDb` on a name with nothing stored creates nothing. */
const RETIRED = ["linearlite", ...Array.from({ length: DATA_VERSION - 2 }, (_, i) => `linearlite-v${i + 2}`)];

let opening: Promise<Linearlite> | undefined;
let opened: Linearlite | undefined;

/**
 * This tab's model, over the database `?db=` names, or the one of this `DATA_VERSION`. Every tab asks for the `linearlite:sync` Web Lock and holds it
 * for its life, so one tab per browser leads sync and the next takes over when it closes.
 */
export function openApp(): Promise<Linearlite> {
  return (opening ??= (async () => {
    const params = new URLSearchParams(location.search);
    const name = params.get("db") ?? DEFAULT_NAME;
    const db = await openDb({ name });
    for (const retired of RETIRED) if (retired !== name) void destroyDb(retired).catch(() => undefined);
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

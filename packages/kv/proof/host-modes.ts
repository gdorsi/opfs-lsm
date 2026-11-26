/**
 * The host modes of a proof page, from its query. Imported first, so it runs
 * before the page opens a database.
 *
 *   ?hosts=dedicated   no SharedWorker in the page, so each handle starts its
 *                      own dedicated Worker, and the testing worker's host
 *                      writes run files there
 *   &staged=1          that worker hides `createWritable()` and stages its
 *                      files, which Chrome allows in a dedicated Worker only
 */
const params = new URLSearchParams(location.search);
export const DEDICATED = params.get("hosts") === "dedicated";
export const STAGED = DEDICATED && params.has("staged");

/** The dedicated Workers this page started for its hosts. */
const hosts: Worker[] = [];

if (DEDICATED) {
  Reflect.deleteProperty(globalThis, "SharedWorker");
  const flags = STAGED ? "#writes,staged" : "#writes";
  const Native = Worker;
  globalThis.Worker = class extends Native {
    constructor(url: string | URL, options?: WorkerOptions) {
      const metered = String(url).includes("metered-worker");
      super(metered ? `${url}${flags}` : url, options);
      if (metered) hosts.push(this);
    }
  };
}

/** Terminate every host this page started, as a kill of the worker alone. Returns how many. */
export function terminateHosts(): number {
  for (const host of hosts) host.terminate();
  return hosts.splice(0).length;
}

/** How a database opened by this page's harness is hosted, for the proof log. */
export function hostLabel(): string {
  if (!DEDICATED) return "SharedWorker";
  return STAGED ? "dedicated Worker staged" : "dedicated Worker";
}

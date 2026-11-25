import type { DbName } from "../check.js";
import { CountingFs, emptyIoCounters, type IoCounters } from "../opfs/counting-fs.js";
import type { HostOverrides } from "./budget.js";
import { EngineHost, type FsFactory, type Meter } from "./engine-host.js";

function countingMeter(): Meter {
  const ios = new Map<DbName, IoCounters>();
  const io = (name: DbName) => {
    let counters = ios.get(name);
    if (!counters) ios.set(name, (counters = emptyIoCounters()));
    return counters;
  };
  return { fs: (name, inner) => new CountingFs(inner, io(name)), io };
}

/**
 * The host of tests, benches and the metered SharedWorker: the shipped host
 * with a meter, so `stats` answers. `@opfs-lsm/kv/testing` exports it as `EngineHost`.
 */
export class MeteredHost extends EngineHost {
  constructor(fsFactory: FsFactory, overrides?: HostOverrides) {
    super(fsFactory, overrides, countingMeter());
  }
}

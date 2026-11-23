import { experimental_createQueryPersister } from "@tanstack/query-persist-client-core";
import { createStore, del, entries, get, set } from "idb-keyval";
import { defineContender } from "../../core/types.ts";

export default defineContender({
  family: "tanstack-query",
  durability: "idb-default",
  fastPath:
    "idb-keyval createStore under experimental_createQueryPersister: one object store, one query = one entry of its JSON; getItem = get, setItem = set (one readwrite transaction each), entries = getAllKeys and getAll in one transaction",
  engine: false,
  async open(name) {
    const store = createStore(`tanstack-query-${name}`, "keyval");
    // idb-keyval opens the database on its first call; pay that inside the timed open, as kv does.
    await get("__bench_open__", store);
    return {
      persister: (options) =>
        experimental_createQueryPersister({
          ...options,
          storage: {
            getItem: (key) => get<string>(key, store),
            setItem: (key, value) => set(key, value, store),
            removeItem: (key) => del(key, store),
            entries: () => entries<string, string>(store),
          },
        }),
      settle: async () => {},
      stats: async () => undefined,
      close: () => store("readonly", (objects) => objects.transaction.db.close()),
    };
  },
});

/*
 * The Solid 2 adapter: a live query as a reactive value. Nothing here is
 * imported by the core entry.
 */
import { createProjection, from, type Accessor } from "solid-js";
import type { LiveQuery } from "./live.js";

/**
 * The live result of the query `source` returns, as an accessor. `source`
 * may read signals: when one changes, the subscription moves to the new
 * query, and the accessor keeps the last result until the new one is read.
 *
 * The result lives in a store whose rows are matched by `id`, so a change to
 * one document updates only what reads the fields that changed. Until the
 * first read the accessor is not ready, as an async memo is, so read it under
 * `<Loading>`. The error that ends a subscription is thrown by the accessor,
 * for `<Errored>` or an effect's `error` to catch.
 */
export function useLiveQuery<V>(source: () => LiveQuery<V>): Accessor<V> {
  const result = createProjection<{ value: V }>(
    () => {
      const query = source();
      return from<{ value: V }>((next, error) => query.subscribe((value) => next({ value }), error));
    },
    undefined,
    { key: "id" },
  );
  return () => result.value;
}

import { useEffect } from "react";
import type { InsertionTarget } from "react-fate";
import type { FilterArgs, StatusCode } from "../domain/model.ts";

/**
 * The lists on screen, as fate returned them. fate puts a new item only into lists a mutation names, so a command
 * that creates or moves an issue or adds a comment names these. Lists elsewhere catch up when they are next fetched.
 */
export type OnScreen = {
  /** The list's window when it starts at row 0 under a newest-first sort, the one a new issue tops. */
  readonly top: Map<"list", { readonly filter: FilterArgs; readonly target: InsertionTarget<"Issue"> }>;
  /** Each board column and the `kanbanorder` of its first card, null when it is empty. */
  readonly columns: Map<StatusCode, { readonly target: InsertionTarget<"Issue">; readonly top: string | null }>;
  readonly comments: Map<string, InsertionTarget<"Comment">>;
};

export const onScreen: OnScreen = { top: new Map(), columns: new Map(), comments: new Map() };

/** Lists `value` under `key` while the calling component is mounted with it; `undefined` lists nothing. */
export function useOnScreen<K, V>(map: Map<K, V>, key: K, value: V | undefined): void {
  useEffect(() => {
    if (value === undefined) return;
    map.set(key, value);
    return () => {
      if (map.get(key) === value) map.delete(key);
    };
  }, [map, key, value]);
}

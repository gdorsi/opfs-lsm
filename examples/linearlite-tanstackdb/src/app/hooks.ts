import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { Issue, StatusCode } from "../domain/model.ts";
import type { IssueFilter } from "../model/filter.ts";
import type { Live } from "../model/live.ts";
import { model } from "./open.ts";

export { LIST_WINDOW } from "../model/views.ts";

const useLive = <T>(live: Live<T>): T => useSyncExternalStore(live.subscribe, live.get);

export function useIssueWindow(filter: IssueFilter) {
  const list = useMemo(() => model().issues.list(filter), [JSON.stringify(filter)]);
  return { ...useLive(list), setRange: list.setRange };
}

export function useBoardColumn(status: StatusCode, filter: IssueFilter) {
  const column = useMemo(() => model().issues.column(filter, status), [JSON.stringify([status, filter])]);
  return { ...useLive(column), setRange: column.setRange };
}

export function useStatusCounts(filter: IssueFilter): readonly number[] | undefined {
  return useLive(useMemo(() => model().issues.counts(filter), [JSON.stringify(filter)]));
}

export function useIssue(id: string): Issue | undefined {
  return useLive(useMemo(() => model().issues.get(id), [id]));
}

export function useIssueDetail(id: string) {
  return useLive(useMemo(() => model().issues.thread(id), [id]));
}

/** Loads the bodies and comments of the issues on screen, once `ids` has held still for a moment. */
export function usePreloadDetails(ids: readonly string[]): void {
  const key = ids.join(","); // ids are [A-Za-z0-9_-]
  useEffect(() => {
    const leave = new AbortController();
    void model().sync.preload(key === "" ? [] : key.split(","), leave.signal);
    return () => leave.abort();
  }, [key]);
}

export const useSyncStatus = () => useLive(model().sync.status);
export const usePressure = () => useLive(model().sync.pressure);

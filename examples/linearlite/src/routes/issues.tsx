import { createLiveQueryCollection, eq } from "@tanstack/db";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect } from "react";
import { STATUS_LABELS, STATUSES, type StatusCode } from "../domain/model.ts";
import * as commands from "../client/commands.ts";
import { parseIssueFilter } from "../client/filter.ts";
import { useIssueWindow, useSyncStatus, type SyncStatus } from "../client/hooks.ts";
import { openStore } from "../client/store.ts";
import { fetchDetail, startSync } from "../client/sync.ts";

export const Route = createFileRoute("/issues")({
  ssr: false,
  validateSearch: parseIssueFilter,
  loader: async () => {
    const store = await openStore();
    startSync(store);
    if (import.meta.env.DEV) Object.assign(globalThis, { __linearlite: { store, commands, fetchDetail, createLiveQueryCollection, eq } });
  },
  component: Issues,
});

const PAGE = 100;

function Issues() {
  const filter = Route.useSearch();
  const { rows, offset, total, setRange } = useIssueWindow(filter);
  useEffect(() => {
    if (rows.length > 0 && performance.getEntriesByName("linearlite:first-rows").length === 0) performance.mark("linearlite:first-rows");
  }, [rows.length]);
  return (
    <main>
      <p id="sync">{describe(useSyncStatus())}</p>
      <p id="range">
        {total === 0 ? 0 : offset + 1}–{offset + rows.length} of {total}{" "}
        <button disabled={offset === 0} onClick={() => setRange(offset - PAGE, offset)}>
          prev
        </button>
        <button disabled={offset + PAGE >= total} onClick={() => setRange(offset + PAGE, offset + 2 * PAGE)}>
          next
        </button>
      </p>
      <table>
        <tbody>
          {rows.map((issue) => (
            <tr key={issue.id} id={`issue-${issue.id}`}>
              <td>{issue.dirty ? "•" : ""}</td>
              <td>{issue.title}</td>
              <td className="status">{STATUS_LABELS[issue.status]}</td>
              <td>
                <select value={issue.status} onChange={(e) => void commands.setStatus(issue.id, Number(e.target.value) as StatusCode)}>
                  {STATUSES.map((s, code) => (
                    <option key={s} value={code}>
                      {STATUS_LABELS[code]}
                    </option>
                  ))}
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}

function describe(status: SyncStatus): string {
  const unsynced = status.unsynced > 0 ? ` · ${status.unsynced} unsynced` : "";
  switch (status.kind) {
    case "starting":
      return `Starting${unsynced}`;
    case "offline":
      return `Offline${unsynced}`;
    case "syncing":
      return `Syncing ${status.stream} ${status.cursor.toLocaleString()} / ${status.head.toLocaleString()}${unsynced}`;
    case "idle":
      return `Synced${unsynced}`;
  }
}

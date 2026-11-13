import { useEffect, useRef, useState } from "react";
import { useFateClient, useListView, useRequest, useViews } from "react-fate";
import { filterArgs } from "../client/args.ts";
import * as commands from "../client/commands.ts";
import { CACHE_ONLY, useSession } from "../client/fate.ts";
import type { IssueFilter } from "../client/filter.ts";
import { placeNewIssue, type Shown } from "../client/place.ts";
import type { PriorityCode, StatusCode } from "../domain/model.ts";
import { useAutosize } from "./autosize.ts";
import { boardRequest, ColumnView, OrderView, type BoardResult } from "./board.tsx";
import { windowRequest } from "./list.tsx";
import { PriorityPicker, StatusPicker } from "./pickers.tsx";

/**
 * The cached lists a new issue with `status` would top under `filter`: its board column, and the list's first window
 * when the list is newest first. Reading them from the cache gives the same lists the screens show.
 */
function useShown(filter: IssueFilter, status: StatusCode): Shown {
  const list = useRequest(windowRequest(filter, 0), CACHE_ONLY)?.issues;
  const column = (useRequest(boardRequest(filter), CACHE_ONLY) as BoardResult | undefined)?.[`c${status}`];
  const [items = []] = useListView(ColumnView, column);
  const orders = useViews(OrderView, items.map((item) => item.node));
  const top = orders.reduce<string | null>((min, o) => (min === null || o.kanbanorder < min ? o.kanbanorder : min), null);
  const newestFirst = filter.dir === "desc" && (filter.sort === "modified" || filter.sort === "created");
  const args = filterArgs(filter);
  return { ...(column && { column: { filter: args, target: column, top } }), ...(newestFirst && list && { list: { filter: args, target: list } }) };
}

export function CreateModal({ filter, onClose }: { filter: IssueFilter; onClose(): void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<StatusCode>(filter.status[0] ?? 0);
  const [priority, setPriority] = useState<PriorityCode>(filter.priority[0] ?? 4);
  const titleRef = useRef<HTMLInputElement>(null);
  const descRef = useRef<HTMLTextAreaElement>(null);
  useAutosize(descRef, description);
  useEffect(() => titleRef.current?.focus(), []);
  const fate = useFateClient();
  const { user } = useSession();
  const shown = useShown(filter, status);

  const ready = title.trim() !== "";
  const submit = () => {
    if (!ready) return;
    const input = { title: title.trim(), description, status, priority };
    void commands.createIssue(fate, user, input, placeNewIssue(shown, input));
    onClose();
  };

  return (
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="modal"
        role="dialog"
        aria-label="New issue"
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
        }}
      >
        <h2>New issue</h2>
        <input ref={titleRef} id="new-title" type="text" placeholder="Issue title" value={title} onChange={(e) => setTitle(e.target.value)} />
        <textarea ref={descRef} id="new-description" placeholder="Add a description…" value={description} onChange={(e) => setDescription(e.target.value)} />
        <div className="modal-foot">
          <StatusPicker variant="pill" value={status} onPick={setStatus} />
          <PriorityPicker variant="pill" value={priority} onPick={setPriority} />
          <span className="spacer" />
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" id="create" disabled={!ready} onClick={submit} title="Create (Cmd/Ctrl+Enter)">
            Create issue
          </button>
        </div>
      </div>
    </div>
  );
}

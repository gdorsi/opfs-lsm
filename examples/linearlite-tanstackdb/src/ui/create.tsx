import { useEffect, useRef, useState } from "react";
import * as commands from "../model/commands.ts";
import type { IssueFilter } from "../model/filter.ts";
import type { PriorityCode, StatusCode } from "../domain/model.ts";
import { useAutosize } from "./autosize.ts";
import { PriorityPicker, StatusPicker } from "./pickers.tsx";

export function CreateModal({ filter, onClose }: { filter: IssueFilter; onClose(): void }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState<StatusCode>(filter.status[0] ?? 0);
  const [priority, setPriority] = useState<PriorityCode>(filter.priority[0] ?? 4);
  const titleRef = useRef<HTMLInputElement>(null);
  const descRef = useRef<HTMLTextAreaElement>(null);
  useAutosize(descRef, description);
  useEffect(() => titleRef.current?.focus(), []);

  const ready = title.trim() !== "";
  const submit = () => {
    if (!ready) return;
    void commands.createIssue({ title: title.trim(), description, status, priority });
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

import { useEffect, useRef, useState } from "react";
import * as commands from "../client/commands.ts";
import { useIssue, useIssueDetail } from "../client/hooks.ts";
import type { Comment, Issue } from "../domain/model.ts";
import { useAutosize } from "./autosize.ts";
import { Loading } from "./boundary.tsx";
import { formatDateTime, initial, shortId } from "./format.ts";
import { PriorityPicker, StatusPicker } from "./pickers.tsx";
import { useGoBack } from "./nav.ts";

const DESCRIPTION_DEBOUNCE_MS = 500;

export function DetailScreen({ id }: { id: string }) {
  const issue = useIssue(id);
  const goBack = useGoBack();
  const [deleting, setDeleting] = useState(false);
  // A delete removes the issue from the cache at once; the screen keeps the last row until it has navigated back.
  const shown = useRef(issue);
  if (issue) shown.current = issue;
  const row = issue ?? (deleting ? shown.current : undefined);
  if (!row) return <NotFound id={id} onBack={goBack} />;
  return <Detail issue={row} onBack={goBack} onDelete={() => setDeleting(true)} onDeleted={goBack} />;
}

function NotFound({ id, onBack }: { id: string; onBack(): void }) {
  return (
    <div className="not-found" id="not-found">
      <div>
        <h2>Issue not found</h2>
        <p>
          There is no issue <span className="mono">{id.slice(0, 8)}</span> on the server. It may have been deleted.
        </p>
        <button className="btn" onClick={onBack}>
          Back to issues
        </button>
      </div>
    </div>
  );
}

function Detail({ issue, onBack, onDelete, onDeleted }: { issue: Issue; onBack(): void; onDelete(): void; onDeleted(): void }) {
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <div className="topbar">
        <div className="crumbs">
          <button className="btn" onClick={onBack} title="Back (Esc)">
            {"←"} Issues
          </button>
          <span className="mono">{shortId(issue.id)}</span>
        </div>
        <span className="spacer" style={{ flex: 1 }} />
        {confirming ? (
          <span className="confirm">
            Delete this issue?
            <button className="btn" onClick={() => setConfirming(false)}>
              Cancel
            </button>
            <button
              className="btn danger"
              id="confirm-delete"
              onClick={() => {
                onDelete();
                void commands.deleteIssue(issue.id).then(onDeleted);
              }}
            >
              Delete
            </button>
          </span>
        ) : (
          <button className="btn danger" id="delete" onClick={() => setConfirming(true)}>
            Delete
          </button>
        )}
      </div>
      <div className="detail">
        <div className="detail-grid">
          <div>
            <TitleField issue={issue} />
            <Loading fallback={<div className="loading">Loading description…</div>}>
              <Description id={issue.id} />
              <Comments issueId={issue.id} />
            </Loading>
          </div>
          <Properties issue={issue} />
        </div>
      </div>
    </>
  );
}

function TitleField({ issue }: { issue: Issue }) {
  const [draft, setDraft] = useState(issue.title);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(issue.title);
  }, [issue.title]);
  const commit = () => {
    const title = draft.trim();
    if (title === "") setDraft(issue.title);
    else if (title !== issue.title) void commands.setTitle(issue.id, title);
  };
  return (
    <input
      className="field-title"
      id="title"
      value={draft}
      aria-label="Title"
      onFocus={() => (focused.current = true)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        focused.current = false;
        commit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") e.currentTarget.blur();
        else if (e.key === "Escape") {
          e.stopPropagation();
          setDraft(issue.title);
          e.currentTarget.blur();
        }
      }}
    />
  );
}

function Description({ id }: { id: string }) {
  const detail = useIssueDetail(id);
  return <DescriptionField id={id} saved={detail.description ?? ""} />;
}

function DescriptionField({ id, saved }: { id: string; saved: string }) {
  const [draft, setDraft] = useState(saved);
  const ref = useRef<HTMLTextAreaElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const unsaved = useRef(false);
  const latest = useRef(draft);
  latest.current = draft;
  useAutosize(ref, draft);

  const flush = () => {
    clearTimeout(timer.current);
    if (!unsaved.current) return;
    unsaved.current = false;
    void commands.setDescription(id, latest.current);
  };

  useEffect(() => {
    if (!unsaved.current && document.activeElement !== ref.current) setDraft(saved);
  }, [saved]);
  useEffect(() => flush, []);

  return (
    <textarea
      ref={ref}
      className="field-desc"
      id="description"
      aria-label="Description"
      placeholder="Add a description…"
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value);
        unsaved.current = true;
        clearTimeout(timer.current);
        timer.current = setTimeout(flush, DESCRIPTION_DEBOUNCE_MS);
      }}
      onBlur={flush}
      onKeyDown={(e) => {
        if (e.key === "Escape") e.currentTarget.blur();
      }}
    />
  );
}

function Comments({ issueId }: { issueId: string }) {
  const { comments } = useIssueDetail(issueId);
  return (
    <section>
      <h3 className="section-h">{comments.length === 0 ? "Comments" : `Comments · ${comments.length}`}</h3>
      <div id="comments">
        {comments.map((c) => (
          <CommentItem key={c.id} comment={c} />
        ))}
      </div>
      <Compose issueId={issueId} />
    </section>
  );
}

function CommentItem({ comment }: { comment: Comment }) {
  return (
    <div className="comment">
      <span className="avatar">{initial(comment.username)}</span>
      <div className="comment-body">
        <div className="comment-meta">
          <b>{comment.username}</b>
          <span>{formatDateTime(comment.created)}</span>
          {comment.dirty && <span className="dot" title="Not synced yet" data-dirty />}
        </div>
        <div className="comment-text">{comment.body}</div>
      </div>
    </div>
  );
}

function Compose({ issueId }: { issueId: string }) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useAutosize(ref, text);
  const submit = () => {
    const body = text.trim();
    if (body === "") return;
    setText("");
    void commands.addComment(issueId, body);
  };
  return (
    <div className="compose">
      <textarea
        ref={ref}
        id="comment-box"
        aria-label="Add a comment"
        placeholder="Leave a comment…"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) submit();
          else if (e.key === "Escape") e.currentTarget.blur();
        }}
      />
      <button className="btn primary" id="comment-submit" disabled={text.trim() === ""} onClick={submit}>
        Comment
      </button>
    </div>
  );
}

function Properties({ issue }: { issue: Issue }) {
  return (
    <aside className="props">
      <div className="prop">
        Status <StatusPicker variant="field" value={issue.status} onPick={(s) => void commands.setStatus(issue.id, s)} />
      </div>
      <div className="prop">
        Priority <PriorityPicker variant="field" value={issue.priority} onPick={(p) => void commands.setPriority(issue.id, p)} />
      </div>
      <div className="prop">
        Created by{" "}
        <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
          <span className="avatar">{initial(issue.username)}</span>
          {issue.username}
        </span>
      </div>
      <div className="prop">
        Created <span>{formatDateTime(issue.created)}</span>
      </div>
      <div className="prop">
        Modified <span>{formatDateTime(issue.modified)}</span>
      </div>
      {issue.dirty && (
        <div className="prop">
          Sync{" "}
          <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }} id="unsynced">
            <span className="dot" /> Not synced yet
          </span>
        </div>
      )}
    </aside>
  );
}

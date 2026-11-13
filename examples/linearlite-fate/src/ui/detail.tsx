import { useEffect, useRef, useState } from "react";
import { useFateClient, useListView, useRequest, useView, view, type ViewRef } from "react-fate";
import * as commands from "../client/commands.ts";
import { REQUEST, useSession } from "../client/fate.ts";
import { useHeld, usePending } from "../client/hooks.ts";
import type { CommentEntity, IssueEntity } from "../domain/model.ts";
import { useAutosize } from "./autosize.ts";
import { Loading } from "./boundary.tsx";
import { formatDateTime, initial, shortId } from "./format.ts";
import { PriorityPicker, StatusPicker } from "./pickers.tsx";
import { useGoBack } from "./nav.ts";

const DESCRIPTION_DEBOUNCE_MS = 500;

const TitleView = view<IssueEntity>()({ id: true, title: true });
const PropertiesView = view<IssueEntity>()({ id: true, status: true, priority: true, username: true, created: true, modified: true });
/** The row fields, which the list's windows usually hold already, so the header paints at once. */
const HeaderView = view<IssueEntity>()({ id: true, ...TitleView, ...PropertiesView });

const DescriptionView = view<IssueEntity>()({ id: true, description: true });
const CommentView = view<CommentEntity>()({ id: true, body: true, username: true, created: true });
const CommentsView = { items: { node: CommentView } } as const;
const ThreadView = view<IssueEntity>()({ id: true, comments: CommentsView });
const BodyView = view<IssueEntity>()({ id: true, ...DescriptionView, ...ThreadView });

export function DetailScreen({ id }: { id: string }) {
  const fate = useFateClient();
  const { issue } = useRequest({ issue: { id, view: HeaderView } }, REQUEST);
  const held = useHeld(id);
  const goBack = useGoBack();
  // A delete removes the issue from the cache at once; the screen shows nothing until it has navigated back.
  const [deleting, setDeleting] = useState(false);
  if (deleting) return null;
  if (!held) return <NotFound id={id} onBack={goBack} />;
  const onDelete = () => {
    setDeleting(true);
    void commands.deleteIssue(fate, id).then(goBack);
  };
  return <Detail id={id} issue={issue} onBack={goBack} onDelete={onDelete} />;
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

function Detail({ id, issue: ref, onBack, onDelete }: { id: string; issue: ViewRef<"Issue">; onBack(): void; onDelete(): void }) {
  // The title and the properties read their own views from what `HeaderView` resolves to.
  const issue = useView(HeaderView, ref);
  const [confirming, setConfirming] = useState(false);
  return (
    <>
      <div className="topbar">
        <div className="crumbs">
          <button className="btn" onClick={onBack} title="Back (Esc)">
            {"←"} Issues
          </button>
          <span className="mono">{shortId(id)}</span>
        </div>
        <span className="spacer" style={{ flex: 1 }} />
        {confirming ? (
          <span className="confirm">
            Delete this issue?
            <button className="btn" onClick={() => setConfirming(false)}>
              Cancel
            </button>
            <button className="btn danger" id="confirm-delete" onClick={onDelete}>
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
              <IssueBody id={id} />
            </Loading>
          </div>
          <Properties issue={issue} />
        </div>
      </div>
    </>
  );
}

/** The description and the comments, oldest first: one request, so they arrive together. */
function IssueBody({ id }: { id: string }) {
  const { issue: ref } = useRequest({ issue: { id, view: BodyView } }, REQUEST);
  const issue = useView(BodyView, ref);
  return (
    <>
      <Description issue={issue} />
      <Comments issue={issue} />
    </>
  );
}

function TitleField({ issue: ref }: { issue: ViewRef<"Issue"> }) {
  const fate = useFateClient();
  const issue = useView(TitleView, ref);
  const [draft, setDraft] = useState(issue.title);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(issue.title);
  }, [issue.title]);
  const commit = () => {
    const title = draft.trim();
    if (title === "") setDraft(issue.title);
    else if (title !== issue.title) void commands.setTitle(fate, issue.id, title);
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

function Description({ issue: ref }: { issue: ViewRef<"Issue"> }) {
  const issue = useView(DescriptionView, ref);
  return <DescriptionField id={issue.id} saved={issue.description} />;
}

function DescriptionField({ id, saved }: { id: string; saved: string }) {
  const fate = useFateClient();
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
    void commands.setDescription(fate, id, latest.current);
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

function Comments({ issue: ref }: { issue: ViewRef<"Issue"> }) {
  const issue = useView(ThreadView, ref);
  const [comments = []] = useListView(CommentsView, issue.comments);
  return (
    <section>
      <h3 className="section-h">{comments.length === 0 ? "Comments" : `Comments · ${comments.length}`}</h3>
      <div id="comments">
        {comments.map(({ node }) => (
          <CommentItem key={node.id} comment={node} />
        ))}
      </div>
      <Compose issueId={issue.id} thread={issue.comments} />
    </section>
  );
}

function CommentItem({ comment: ref }: { comment: ViewRef<"Comment"> }) {
  const comment = useView(CommentView, ref);
  const pending = usePending(comment.id);
  return (
    <div className="comment">
      <span className="avatar">{initial(comment.username)}</span>
      <div className="comment-body">
        <div className="comment-meta">
          <b>{comment.username}</b>
          <span>{formatDateTime(comment.created)}</span>
          {pending && <span className="dot" title="Not synced yet" data-dirty />}
        </div>
        <div className="comment-text">{comment.body}</div>
      </div>
    </div>
  );
}

function Compose({ issueId, thread }: { issueId: string; thread: Parameters<typeof commands.addComment>[4] }) {
  const fate = useFateClient();
  const { user } = useSession();
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useAutosize(ref, text);
  const submit = () => {
    const body = text.trim();
    if (body === "") return;
    setText("");
    void commands.addComment(fate, user, issueId, body, thread);
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

function Properties({ issue: ref }: { issue: ViewRef<"Issue"> }) {
  const fate = useFateClient();
  const issue = useView(PropertiesView, ref);
  const pending = usePending(issue.id);
  return (
    <aside className="props">
      <div className="prop">
        Status <StatusPicker variant="field" value={issue.status} onPick={(s) => void commands.setStatus(fate, issue.id, s)} />
      </div>
      <div className="prop">
        Priority <PriorityPicker variant="field" value={issue.priority} onPick={(p) => void commands.setPriority(fate, issue.id, p)} />
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
      {pending && (
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

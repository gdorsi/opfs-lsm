import { useEffect, useRef, useState } from "react";
import type { App } from "./app.ts";
import { shortDate, shortId } from "./issues.tsx";
import { CodeLabel, codeItems, MenuButton } from "./menu.tsx";
import type { Detail as Details, Issue } from "./model.ts";

const full = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });

/** The issue page. Its title, status and priority are each saved as one write, and it shows what the change feed sends back. */
export function Detail({ app, issue, detail }: { app: App; issue: Issue; detail: Details | undefined }) {
  const title = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(issue.title);
  // A write from elsewhere shows at once, unless the title is being edited.
  useEffect(() => {
    if (document.activeElement !== title.current) setDraft(issue.title);
  }, [issue.title]);

  const save = () => {
    const next = draft.trim();
    if (next === "") setDraft(issue.title);
    else if (next !== issue.title) app.edit(issue.id, { title: next });
  };
  const pick = (field: "status" | "priority") => codeItems(field, (c) => issue[field] === c, (c) => app.edit(issue.id, { [field]: c }));

  return (
    <div className="detail">
      <div className="detail-grid">
        <div>
          <div className="crumbs">
            <button className="btn" id="back" onClick={app.close}>
              ← Issues
            </button>
            <span className="mono" id="issue-id">
              {shortId(issue.id)}
            </span>
          </div>
          <input
            ref={title}
            className="field-title"
            aria-label="Title"
            autoComplete="off"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={save}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
          />
          <p className="field-desc">{detail?.description}</p>
          {detail && detail.comments.length > 0 && <h3 className="section-h">Comments</h3>}
          <div id="comments">
            {detail?.comments.map((c) => (
              <div key={c.id} className="comment">
                <span className="avatar">{c.username.slice(0, 1)}</span>
                <div className="comment-body">
                  <div className="comment-meta">
                    <b>{c.username}</b>
                    <span>{shortDate(c.created)}</span>
                  </div>
                  <div className="comment-text">{c.body}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
        <aside className="props">
          <div className="prop">
            <span>Status</span>
            <MenuButton className="menu-btn" title="Status" items={pick("status")}>
              <CodeLabel field="status" code={issue.status} />
            </MenuButton>
          </div>
          <div className="prop">
            <span>Priority</span>
            <MenuButton className="menu-btn" title="Priority" items={pick("priority")}>
              <CodeLabel field="priority" code={issue.priority} />
            </MenuButton>
          </div>
          <div className="prop">
            <span>Assignee</span>
            <span id="assignee">{issue.username}</span>
          </div>
          <div className="prop">
            <span>Created</span>
            <span id="created">{full.format(issue.created)}</span>
          </div>
          <div className="prop">
            <span>Modified</span>
            <span id="modified">{full.format(issue.modified)}</span>
          </div>
        </aside>
      </div>
    </div>
  );
}

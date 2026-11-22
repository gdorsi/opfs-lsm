import { createSignal, For, onSettled, Show } from "solid-js";
import type { App } from "./app.ts";
import { shortDate, shortId } from "./issues.tsx";
import { CodeLabel, codeItems, MenuButton } from "./menu.tsx";
import type { Detail as Details, Issue } from "./model.ts";

const full = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });

/** The issue page. Its title, status and priority are each saved as one write, and it shows what the change feed sends back. */
export function Detail(props: { app: App; issue: Issue; detail: Details | undefined }) {
  let title: HTMLInputElement | undefined;
  // A write from elsewhere shows at once, unless the title is being edited.
  const [draft, setDraft] = createSignal<string>((editing) => (editing !== undefined && document.activeElement === title ? editing : props.issue.title));

  // Removing the page blurs a focused title after its issue is gone, and that blur saves nothing.
  let open = true;
  onSettled(() => () => (open = false));

  const save = () => {
    if (!open) return;
    const next = draft().trim();
    if (next === "") setDraft(props.issue.title);
    else if (next !== props.issue.title) props.app.edit(props.issue.id, { title: next });
  };
  const pick = (field: "status" | "priority") =>
    codeItems(field, (c) => props.issue[field] === c, (c) => props.app.edit(props.issue.id, { [field]: c }));

  return (
    <div class="detail">
      <div class="detail-grid">
        <div>
          <div class="crumbs">
            <button class="btn" id="back" onClick={() => props.app.close()}>
              ← Issues
            </button>
            <span class="mono" id="issue-id">
              {shortId(props.issue.id)}
            </span>
          </div>
          <input
            ref={(el) => (title = el)}
            class="field-title"
            aria-label="Title"
            autocomplete="off"
            value={draft()}
            onInput={(e) => setDraft(e.currentTarget.value)}
            onBlur={save}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
            }}
          />
          <p class="field-desc">{props.detail?.description}</p>
          <Show when={props.detail && props.detail.comments.length > 0}>
            <h3 class="section-h">Comments</h3>
          </Show>
          <div id="comments">
            <For each={props.detail?.comments}>
              {(c) => (
                <div class="comment">
                  <span class="avatar">{c.username.slice(0, 1)}</span>
                  <div class="comment-body">
                    <div class="comment-meta">
                      <b>{c.username}</b>
                      <span>{shortDate(c.created)}</span>
                    </div>
                    <div class="comment-text">{c.body}</div>
                  </div>
                </div>
              )}
            </For>
          </div>
        </div>
        <aside class="props">
          <div class="prop">
            <span>Status</span>
            <MenuButton class="menu-btn" title="Status" items={pick("status")}>
              <CodeLabel field="status" code={props.issue.status} />
            </MenuButton>
          </div>
          <div class="prop">
            <span>Priority</span>
            <MenuButton class="menu-btn" title="Priority" items={pick("priority")}>
              <CodeLabel field="priority" code={props.issue.priority} />
            </MenuButton>
          </div>
          <div class="prop">
            <span>Assignee</span>
            <span id="assignee">{props.issue.username}</span>
          </div>
          <div class="prop">
            <span>Created</span>
            <span id="created">{full.format(props.issue.created)}</span>
          </div>
          <div class="prop">
            <span>Modified</span>
            <span id="modified">{full.format(props.issue.modified)}</span>
          </div>
        </aside>
      </div>
    </div>
  );
}

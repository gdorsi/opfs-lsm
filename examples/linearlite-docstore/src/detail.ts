import { escape } from "./icons.ts";
import { shortDate, shortId } from "./list.ts";
import { codeItems, codeLabel, openMenu } from "./menu.ts";
import type { Detail, Issue } from "./model.ts";
import { failed } from "./protocol.ts";
import { detailOf, editIssue, type Store } from "./store.ts";

const full = new Intl.DateTimeFormat("en", { dateStyle: "medium", timeStyle: "short" });

/** The issue page. Its title, status and priority are each saved as one write, and it shows what the change feed sends back. */
export function createDetail(el: HTMLElement, store: Store) {
  el.innerHTML = `
<div class="detail-grid">
  <div>
    <div class="crumbs"><button class="btn" id="back">← Issues</button><span class="mono" id="issue-id"></span></div>
    <input class="field-title" aria-label="Title" autocomplete="off" />
    <p class="field-desc"></p>
    <h3 class="section-h">Comments</h3>
    <div id="comments"></div>
  </div>
  <aside class="props">
    <div class="prop"><span>Status</span><button class="menu-btn" title="Status"></button></div>
    <div class="prop"><span>Priority</span><button class="menu-btn" title="Priority"></button></div>
    <div class="prop"><span>Assignee</span><span id="assignee"></span></div>
    <div class="prop"><span>Created</span><span id="created"></span></div>
    <div class="prop"><span>Modified</span><span id="modified"></span></div>
  </aside>
</div>`;
  const $ = <T extends HTMLElement>(selector: string) => el.querySelector<T>(selector)!;
  const title = $<HTMLInputElement>(".field-title");
  let issue: Issue | undefined;

  const draw = () => {
    if (!issue) return;
    $("#issue-id").textContent = shortId(issue.id);
    if (document.activeElement !== title) title.value = issue.title;
    $('[title="Status"]').innerHTML = codeLabel("status", issue.status);
    $('[title="Priority"]').innerHTML = codeLabel("priority", issue.priority);
    $("#assignee").textContent = issue.username;
    $("#created").textContent = full.format(issue.created);
    $("#modified").textContent = full.format(issue.modified);
  };
  const drawDetail = (detail: Detail | undefined) => {
    $(".field-desc").textContent = detail?.description ?? "";
    $("#comments").innerHTML = (detail?.comments ?? [])
      .map(
        (c) =>
          `<div class="comment"><span class="avatar">${escape(c.username.slice(0, 1))}</span><div class="comment-body">` +
          `<div class="comment-meta"><b>${escape(c.username)}</b><span>${shortDate(c.created)}</span></div><div class="comment-text">${escape(c.body)}</div></div></div>`,
      )
      .join("");
    $(".section-h").hidden = !detail || detail.comments.length === 0;
  };

  const edit = (patch: Parameters<typeof editIssue>[2]) => {
    if (issue) void editIssue(store, issue.id, patch).catch(failed);
  };
  const close = () => {
    issue = undefined;
    el.hidden = true;
  };

  title.onchange = () => {
    const next = title.value.trim();
    if (!issue) return;
    if (next === "") title.value = issue.title;
    else if (next !== issue.title) edit({ title: next });
  };
  title.onkeydown = (e) => {
    if (e.key === "Enter") title.blur();
  };
  for (const field of ["status", "priority"] as const) {
    const button = $<HTMLButtonElement>(`[title="${field === "status" ? "Status" : "Priority"}"]`);
    button.onclick = () => openMenu(button, () => codeItems(field, (c) => issue?.[field] === c, (c) => edit({ [field]: c })), false);
  }
  $("#back").onclick = close;

  return {
    open(next: Issue) {
      issue = next;
      el.hidden = false;
      el.scrollTop = 0;
      draw();
      drawDetail(undefined);
      detailOf(store, next).then((detail) => {
        if (issue?.id === next.id) drawDetail(detail);
      }, failed);
    },
    close,
    /** The issue on the page, as last stored, while the page is open. */
    get issue() {
      return issue;
    },
    /** Shows the issue as a write left it. A deleted issue closes the page. */
    update(next: Issue | undefined) {
      if (!next) return close();
      issue = next;
      draw();
    },
  };
}

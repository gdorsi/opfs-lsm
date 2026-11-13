import type { Code } from "./model.ts";

const svg = (body: string) => `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" class="ico" aria-hidden="true">${body}</svg>`;
const RING = `<circle cx="7" cy="7" r="5.5" stroke="currentColor" stroke-width="1.5"/>`;

const STATUS = [
  `<circle cx="7" cy="7" r="5.5" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2.2 2.2"/>`,
  RING,
  `${RING}<path d="M7 3.5a3.5 3.5 0 0 1 0 7z" fill="currentColor"/>`,
  `<circle cx="7" cy="7" r="6.25" fill="currentColor"/><path d="M4.3 7.2l1.9 1.9 3.5-3.7" stroke="var(--bg)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`,
  `${RING}<path d="M5 5l4 4M9 5l-4 4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>`,
].map((body, code) => `<span class="st-${code} ico-wrap">${svg(body)}</span>`);

const BARS = [3, 3, 2, 1, 0];
const PRIORITY = BARS.map((bars, code) => {
  const body =
    code === 0
      ? `<rect x="1.5" y="1.5" width="11" height="11" rx="3" fill="currentColor"/><path d="M7 4v3.6M7 9.4v.6" stroke="var(--bg)" stroke-width="1.5" stroke-linecap="round"/>`
      : [0, 1, 2].map((i) => `<rect x="${1.5 + i * 4}" y="${9 - i * 3}" width="2.6" height="${3.5 + i * 3}" rx="0.8" fill="currentColor" opacity="${i < bars ? 1 : 0.28}"/>`).join("");
  return `<span class="pr-${code} ico-wrap">${svg(body)}</span>`;
});

export const statusIcon = (status: Code) => STATUS[status]!;
export const priorityIcon = (priority: Code) => PRIORITY[priority]!;
export const CHECK = `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M2.5 6.3l2.4 2.4 4.6-5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
export const escape = (text: string) => text.replace(/[&<>"]/g, (c) => ESCAPES[c]!);

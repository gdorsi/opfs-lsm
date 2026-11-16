import type { Block, Marks, Span, TextEdit } from "../model/types.ts";

/** A document as the edits that type it into an empty body, and the spans those edits must produce. */
export type BuiltBody = {
  readonly edits: readonly TextEdit[];
  readonly spans: readonly Span[];
  /** The index just past the last character: where the next typed character goes. */
  readonly end: number;
};

const WORDS = [
  "local", "first", "storage", "page", "tree", "block", "merge", "offline", "sync", "heading",
  "cursor", "draft", "title", "folder", "write", "reload", "shared", "change", "note", "list",
];
const LINK = "https://example.com/docs";

/**
 * A document of at least `bytes` characters of text. A heading opens every
 * 50th paragraph, a bold run sits in every 10th and a link in every 100th.
 * The spans are built from the same loop but never through the model or the
 * oracle, so a bug in either shows as a difference.
 */
export function builtBody(bytes: number): BuiltBody {
  const edits: TextEdit[] = [];
  const spans: Span[] = [];
  const paragraph: Block = { type: "paragraph" };
  let at = 1;
  let chars = 0;
  for (let k = 0; chars < bytes; k++) {
    const block: Block = k % 50 === 0 ? { type: "heading", level: 1 } : paragraph;
    if (k === 0) edits.push({ type: "setBlock", at: 0, block });
    else edits.push({ type: "split", at: at++, block });
    spans.push({ type: "block", block });
    const sentence = (n: number) =>
      Array.from({ length: n }, (_, i) => WORDS[(k * 7 + i * 3) % WORDS.length]).join(" ");
    const pieces: [string, Marks][] = [[`${sentence(6)} `, {}]];
    if (k % 10 === 5) pieces.push([sentence(2), { bold: true }], [" and then ", {}]);
    if (k % 100 === 7) pieces.push([sentence(2), { link: LINK }], [` ${sentence(3)}.`, {}]);
    else pieces.push([`${sentence(4)}.`, {}]);
    for (const [text, marks] of pieces) {
      edits.push({ type: "insert", at, text, marks });
      const last = spans.at(-1);
      if (last?.type === "text" && JSON.stringify(last.marks) === JSON.stringify(marks)) {
        spans[spans.length - 1] = { type: "text", text: last.text + text, marks };
      } else {
        spans.push({ type: "text", text, marks });
      }
      at += text.length;
      chars += text.length;
    }
  }
  return { edits, spans, end: at };
}

/**
 * The body's vocabulary, `TextEdit` and `Span`, mapped onto Automerge rich
 * text in both directions. Edits never read the text through the change
 * proxy, and patches translate in O(patches). Only `toSpans` is O(doc).
 */
import * as A from "@automerge/automerge";
import { PagesError } from "./errors.ts";
import type { Block, Depth, MarkEdit, MarkName, Marks, Span, TextEdit } from "./types.ts";

export type BodyDoc = { text: string };

const PATH = ["text"];
const MARK_NAMES: readonly MarkName[] = ["bold", "italic", "code", "link"];

type Marker = { type: string; parents: never[]; attrs: Record<string, A.MaterializeValue> };

function toMarker(block: Block): Marker {
  const { type, ...attrs } = block;
  return { type, parents: [], attrs };
}

const DEPTHS: readonly unknown[] = [0, 1, 2, 3, 4, 5];

/** Peers write these markers, so read them as untrusted: anything unknown is a paragraph. */
function parseBlock(raw: { [key: string]: A.MaterializeValue } | null): Block {
  const attrs = (raw?.attrs ?? {}) as Record<string, unknown>;
  const depth = (DEPTHS.includes(attrs.depth) ? attrs.depth : 0) as Depth;
  switch (raw?.type) {
    case "heading":
      if (attrs.level === 1 || attrs.level === 2 || attrs.level === 3) return { type: "heading", level: attrs.level };
      break;
    case "item":
      if (attrs.list === "bullet" || attrs.list === "number") return { type: "item", list: attrs.list, depth };
      break;
    case "todo":
      return { type: "todo", depth, checked: attrs.checked === true };
  }
  return { type: "paragraph" };
}

function parseMarks(raw: A.MarkSet | undefined): Marks {
  if (!raw) return {};
  return {
    ...(raw.bold === true && { bold: true }),
    ...(raw.italic === true && { italic: true }),
    ...(raw.code === true && { code: true }),
    ...(typeof raw.link === "string" && { link: raw.link }),
  };
}

function parseMarkEdit(name: string, value: unknown, start: number, end: number): MarkEdit | null {
  if (name === "link") {
    if (value === null || typeof value === "string") return { type: "mark", start, end, name, value };
    return null;
  }
  if (name !== "bold" && name !== "italic" && name !== "code") return null;
  return { type: "mark", start, end, name, value: value === true ? true : null };
}

function sameMarks(a: Marks, b: Marks): boolean {
  return MARK_NAMES.every((name) => a[name] === b[name]);
}

function invalid(edit: TextEdit, why: string): PagesError {
  return new PagesError("invalid", `${why}: ${JSON.stringify(edit)}`);
}

/**
 * How each mark grows when text is typed at its end. Automerge picks the
 * marks of inserted text by this rule, and `applyEdits` corrects them only
 * when the rule disagrees with `insert.marks`, so typing inside or after a
 * run usually needs no mark ops at all.
 */
const EXPAND = { bold: "after", italic: "after", code: "after", link: "none" } as const satisfies Record<MarkName, string>;

function setMark(d: A.Doc<BodyDoc>, start: number, end: number, name: MarkName, value: string | true | null): void {
  const range = { start, end, expand: EXPAND[name] };
  if (value === null) A.unmark(d, PATH, range, name);
  else A.mark(d, PATH, range, name, value);
}

/** Applies one edit inside a change. An insert takes whatever marks Automerge gives it; `applyEdits` corrects them. */
function applyEdit(d: A.Doc<BodyDoc>, edit: TextEdit): void {
  switch (edit.type) {
    case "insert":
      if (edit.at < 1) throw invalid(edit, "insert before the first block");
      if (edit.text.length === 0) throw invalid(edit, "empty insert");
      A.splice(d, PATH, edit.at, 0, edit.text);
      return;
    case "delete":
      if (edit.at < 1) throw invalid(edit, "delete of the first block");
      if (edit.count < 1) throw invalid(edit, "empty delete");
      A.splice(d, PATH, edit.at, edit.count);
      return;
    case "split":
      if (edit.at < 1) throw invalid(edit, "split before the first block");
      A.splitBlock(d, PATH, edit.at, toMarker(edit.block));
      return;
    case "setBlock":
      // updateBlock on a text index silently turns that character into a marker.
      if (A.block(d, PATH, edit.at) === null) throw invalid(edit, "no block at index");
      A.updateBlock(d, PATH, edit.at, toMarker(edit.block));
      return;
    case "mark":
      if (edit.start < 0 || edit.end <= edit.start) throw invalid(edit, "empty mark range");
      setMark(d, edit.start, edit.end, edit.name, edit.value);
      return;
  }
}

/** A run of text inserted by the batch, at its index after the ops seen so far. */
type Piece = { at: number; length: number; marks: Marks };

/**
 * The text a batch inserted, followed through the ops after each insert.
 * Two of these replay one batch, from the edits and from the patches of its
 * change, and end on the same characters at the same indexes.
 */
class Inserted {
  readonly pieces: Piece[] = [];

  /**
   * Splits the piece that straddles `at`, and returns the index of the first piece at or after it.
   * Pieces are sorted and never overlap, so a binary search finds it: a paste is thousands of edits.
   */
  cut(at: number): number {
    let lo = 0;
    let hi = this.pieces.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const piece = this.pieces[mid]!;
      if (piece.at >= at || piece.at + piece.length > at) hi = mid;
      else lo = mid + 1;
    }
    const piece = this.pieces[lo];
    if (!piece || piece.at >= at) return lo;
    const head = at - piece.at;
    this.pieces.splice(lo, 1, { ...piece, length: head }, { at, length: piece.length - head, marks: piece.marks });
    return lo + 1;
  }

  /** `marks: null` is a block marker: it moves the text after it but is not tracked. */
  insert(at: number, length: number, marks: Marks | null): void {
    const i = this.cut(at);
    for (let j = i; j < this.pieces.length; j++) this.pieces[j]!.at += length;
    if (marks) this.pieces.splice(i, 0, { at, length, marks });
  }

  remove(at: number, count: number): void {
    const from = this.cut(at);
    const to = this.cut(at + count);
    this.pieces.splice(from, to - from);
    for (let j = from; j < this.pieces.length; j++) this.pieces[j]!.at -= count;
  }

  mark(start: number, end: number, name: MarkName, value: string | true | null): void {
    const from = this.cut(start);
    const to = this.cut(end);
    for (let j = from; j < to; j++) {
      const piece = this.pieces[j]!;
      const { [name]: _old, ...rest } = piece.marks;
      piece.marks = value === null ? rest : { ...rest, [name]: value };
    }
  }
}

function replayEdits(edits: readonly TextEdit[]): Inserted {
  const want = new Inserted();
  for (const edit of edits) {
    if (edit.type === "insert") want.insert(edit.at, edit.text.length, edit.marks);
    else if (edit.type === "delete") want.remove(edit.at, edit.count);
    else if (edit.type === "split") want.insert(edit.at, 1, null);
    else if (edit.type === "mark") want.mark(edit.start, edit.end, edit.name, edit.value);
  }
  return want;
}

/** Local patches come in op order, with each splice carrying the marks Automerge gave it. */
function replayPatches(patches: readonly A.Patch[]): Inserted {
  const got = new Inserted();
  const mark = (edit: MarkEdit | null) => {
    if (edit) got.mark(edit.start, edit.end, edit.name, edit.value);
  };
  for (const patch of patches) {
    if (patch.path[0] !== PATH[0]) continue;
    if (patch.path.length === 1) {
      if (patch.action === "mark") for (const m of patch.marks) mark(parseMarkEdit(m.name, m.value, m.start, m.end));
      else if (patch.action === "unmark") mark(parseMarkEdit(patch.name, null, patch.start, patch.end));
      continue;
    }
    const at = patch.path[1];
    if (patch.path.length > 2 || typeof at !== "number") continue;
    if (patch.action === "splice") got.insert(at, patch.value.length, parseMarks(patch.marks));
    else if (patch.action === "del") got.remove(at, patch.length ?? 1);
    else if (patch.action === "insert") got.insert(at, patch.values.length, null);
  }
  return got;
}

type MarkFix = { start: number; end: number; name: MarkName; value: string | true | null };

/**
 * The mark ops that turn the inserted text's marks from `got` into `want`.
 * Empty when Automerge's guess was right. Should the two replays ever cover
 * different characters, every mark of the inserted text is written instead.
 */
function markFixes(want: Inserted, got: Inserted): MarkFix[] {
  for (const [a, b] of [[want, got], [got, want]] as const) {
    for (const piece of b.pieces) {
      a.cut(piece.at);
      a.cut(piece.at + piece.length);
    }
  }
  const aligned =
    want.pieces.length === got.pieces.length &&
    want.pieces.every((piece, i) => piece.at === got.pieces[i]!.at && piece.length === got.pieces[i]!.length);
  const fixes: MarkFix[] = [];
  for (const name of MARK_NAMES) {
    const first = fixes.length;
    for (const [i, piece] of want.pieces.entries()) {
      if (aligned && piece.marks[name] === got.pieces[i]!.marks[name]) continue;
      const value = piece.marks[name] ?? null;
      const end = piece.at + piece.length;
      const last = fixes.length > first ? fixes.at(-1) : undefined;
      if (last?.end === piece.at && last.value === value) last.end = end;
      else fixes.push({ start: piece.at, end, name, value });
    }
  }
  return fixes;
}

/** Runs `fn` as one Automerge change, passing `options` through, as `DocHandle.change` does. */
type Change = (fn: A.ChangeFn<BodyDoc>, options: A.ChangeOptions<BodyDoc>) => void;

/**
 * Applies `edits` in one change. Inserted text first takes the marks
 * Automerge's expand rule gives it, read back from the change's splice
 * patches. Only where they differ from `insert.marks` does a second change
 * set or remove marks over that text. Returns whether it made one.
 */
export function applyEdits(change: Change, edits: readonly TextEdit[]): boolean {
  let patches: readonly A.Patch[] = [];
  change(
    (d) => {
      for (const edit of edits) applyEdit(d, edit);
    },
    {
      patchCallback: (p) => {
        patches = p;
      },
    },
  );
  if (!edits.some((edit) => edit.type === "insert")) return false;
  const fixes = markFixes(replayEdits(edits), replayPatches(patches));
  if (fixes.length === 0) return false;
  change((d) => {
    for (const fix of fixes) setMark(d, fix.start, fix.end, fix.name, fix.value);
  }, {});
  return true;
}

/** The body as spans, with adjacent text of equal marks merged. O(doc). */
export function toSpans(doc: A.Doc<BodyDoc>): Span[] {
  const out: Span[] = [];
  for (const span of A.spans(doc, PATH)) {
    if (span.type === "block") {
      out.push({ type: "block", block: parseBlock(span.value) });
      continue;
    }
    const marks = parseMarks(span.marks);
    const last = out.at(-1);
    if (last?.type === "text" && sameMarks(last.marks, marks)) {
      out[out.length - 1] = { type: "text", text: last.text + span.value, marks };
    } else {
      out.push({ type: "text", text: span.value, marks });
    }
  }
  return out;
}

/**
 * Translates the patches of a remote change event into edits that, applied
 * in order, turn the old spans into the new ones. Block values are read from
 * `after` at each marker's final index, because a new or updated marker
 * arrives as several patches on its properties.
 */
export function toTextEdits(patches: readonly A.Patch[], after: A.Doc<BodyDoc>): TextEdit[] {
  const edits: TextEdit[] = [];
  /** Markers inserted or changed by these patches, at their index after the patches seen so far. */
  const markers: { at: number; split: number | null }[] = [];
  const shift = (from: number, by: number) => {
    for (let i = markers.length - 1; i >= 0; i--) {
      const marker = markers[i]!;
      if (marker.at < from) continue;
      if (by < 0 && marker.at < from - by) markers.splice(i, 1);
      else marker.at += by;
    }
  };
  const pushMark = (edit: MarkEdit | null) => {
    if (edit) edits.push(edit);
  };

  for (const patch of patches) {
    if (patch.path[0] !== PATH[0]) continue;
    if (patch.path.length === 1) {
      if (patch.action === "mark") {
        for (const mark of patch.marks) pushMark(parseMarkEdit(mark.name, mark.value, mark.start, mark.end));
      } else if (patch.action === "unmark") {
        pushMark(parseMarkEdit(patch.name, null, patch.start, patch.end));
      }
      continue;
    }
    const at = patch.path[1];
    if (typeof at !== "number") continue;
    if (patch.path.length > 2) {
      if (!markers.some((marker) => marker.at === at)) markers.push({ at, split: null });
      continue;
    }
    switch (patch.action) {
      case "splice":
        edits.push({ type: "insert", at, text: patch.value, marks: parseMarks(patch.marks) });
        shift(at, patch.value.length);
        break;
      case "del": {
        const count = patch.length ?? 1;
        edits.push({ type: "delete", at, count });
        shift(at, -count);
        break;
      }
      case "insert":
        shift(at, patch.values.length);
        for (let i = 0; i < patch.values.length; i++) {
          markers.push({ at: at + i, split: edits.length });
          edits.push({ type: "split", at: at + i, block: { type: "paragraph" } });
        }
        break;
    }
  }

  for (const { at, split } of markers) {
    const block = parseBlock(A.block(after, PATH, at));
    if (split === null) edits.push({ type: "setBlock", at, block });
    else edits[split] = { ...(edits[split] as Extract<TextEdit, { type: "split" }>), block };
  }
  return edits;
}

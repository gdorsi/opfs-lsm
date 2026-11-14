/**
 * The oracle for one body: a plain array of runs, with adjacent text of equal
 * marks merged. It imports nothing at runtime, so a bug in the model cannot
 * leak into the answer it is checked against.
 *
 * Rules: inserted text gets exactly `edit.marks`; a mark edit skips block
 * markers; deleting a marker joins its block into the one before.
 */
import type { MarkName, Marks, Span, TextEdit } from "../model/types.ts";

export interface ReferenceBody {
  edit(edits: readonly TextEdit[]): void;
  spans(): readonly Span[];
  /** Markers plus text length, in Automerge indexes. */
  length(): number;
  /** The index of every block marker. */
  blocks(): readonly number[];
}

const MARK_NAMES: readonly MarkName[] = ["bold", "italic", "code", "link"];

const size = (span: Span) => (span.type === "block" ? 1 : span.text.length);
const sameMarks = (a: Marks, b: Marks) => MARK_NAMES.every((name) => a[name] === b[name]);

function withMark(marks: Marks, name: MarkName, value: string | true | null): Marks {
  const { [name]: _dropped, ...rest } = marks;
  return value === null ? rest : { ...rest, [name]: value };
}

export function referenceBody(start: readonly Span[] = [{ type: "block", block: { type: "paragraph" } }]): ReferenceBody {
  let runs: Span[] = [...start];

  /** Splits the run that straddles `at` and returns the index of the run that starts there. */
  const cut = (at: number): number => {
    let pos = 0;
    for (let i = 0; i < runs.length; i++) {
      if (pos === at) return i;
      const run = runs[i]!;
      const end = pos + size(run);
      if (at < end && run.type === "text") {
        const k = at - pos;
        runs.splice(i, 1, { ...run, text: run.text.slice(0, k) }, { ...run, text: run.text.slice(k) });
        return i + 1;
      }
      pos = end;
    }
    if (pos === at) return runs.length;
    throw new RangeError(`index ${at} is past the end (${pos})`);
  };

  const normalize = () => {
    const out: Span[] = [];
    for (const run of runs) {
      if (run.type === "text" && run.text.length === 0) continue;
      const last = out.at(-1);
      if (run.type === "text" && last?.type === "text" && sameMarks(last.marks, run.marks)) {
        out[out.length - 1] = { ...last, text: last.text + run.text };
      } else {
        out.push(run);
      }
    }
    runs = out;
  };

  const apply = (edit: TextEdit) => {
    switch (edit.type) {
      case "insert":
        runs.splice(cut(edit.at), 0, { type: "text", text: edit.text, marks: { ...edit.marks } });
        return;
      case "split":
        runs.splice(cut(edit.at), 0, { type: "block", block: edit.block });
        return;
      case "delete": {
        const from = cut(edit.at);
        runs.splice(from, cut(edit.at + edit.count) - from);
        return;
      }
      case "setBlock": {
        const i = cut(edit.at);
        if (runs[i]?.type !== "block") throw new RangeError(`no block at ${edit.at}`);
        runs[i] = { type: "block", block: edit.block };
        return;
      }
      case "mark": {
        const from = cut(edit.start);
        const to = cut(edit.end);
        for (let i = from; i < to; i++) {
          const run = runs[i]!;
          if (run.type === "text") runs[i] = { ...run, marks: withMark(run.marks, edit.name, edit.value) };
        }
        return;
      }
    }
  };

  return {
    edit(edits) {
      for (const edit of edits) {
        apply(edit);
        normalize();
      }
    },
    spans: () => [...runs],
    length: () => runs.reduce((n, run) => n + size(run), 0),
    blocks() {
      const at: number[] = [];
      let pos = 0;
      for (const run of runs) {
        if (run.type === "block") at.push(pos);
        pos += size(run);
      }
      return at;
    },
  };
}

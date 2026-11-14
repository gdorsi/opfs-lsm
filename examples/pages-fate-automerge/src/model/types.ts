import type { DocumentId, StorageAdapterInterface } from "@automerge/automerge-repo";
import type { PersistenceStorage } from "@nkzw/fate/persistence";
import type { PagesError } from "./errors.ts";

/** A page's id is the Automerge DocumentId of its body, so a page and its body share one id. */
export type PageId = DocumentId;

export type Depth = 0 | 1 | 2 | 3 | 4 | 5;

/** A block marker. The list is flat: nesting is `depth`. */
export type Block =
  | { readonly type: "paragraph" }
  | { readonly type: "heading"; readonly level: 1 | 2 | 3 }
  | { readonly type: "item"; readonly list: "bullet" | "number"; readonly depth: Depth }
  | { readonly type: "todo"; readonly depth: Depth; readonly checked: boolean };

/** The marks a run of text carries. A link's value is its URL. */
export type Marks = {
  readonly bold?: true;
  readonly italic?: true;
  readonly code?: true;
  readonly link?: string;
};

export type MarkName = keyof Marks;

export type Span =
  | { readonly type: "block"; readonly block: Block }
  | { readonly type: "text"; readonly text: string; readonly marks: Marks };

/**
 * One change to a body. Positions index the Automerge text, where each block
 * marker counts as one character and text counts UTF-16 code units. Index 0
 * is the first block marker, which no edit may remove.
 */
export type TextEdit =
  | { readonly type: "insert"; readonly at: number; readonly text: string; readonly marks: Marks }
  | { readonly type: "delete"; readonly at: number; readonly count: number }
  | { readonly type: "split"; readonly at: number; readonly block: Block }
  | { readonly type: "setBlock"; readonly at: number; readonly block: Block }
  | MarkEdit;

/** Sets `name` on the text in `[start, end)`; `value: null` removes it. Block markers are skipped. */
export type MarkEdit = {
  readonly [N in MarkName]: {
    readonly type: "mark";
    readonly start: number;
    readonly end: number;
    readonly name: N;
    readonly value: Exclude<Marks[N], undefined> | null;
  };
}[MarkName];

/** Fits React's useSyncExternalStore: `read` returns the same object until a listener fires. */
export interface View<T> {
  read(): T;
  subscribe(listener: () => void): () => void;
}

export type SaveState =
  | { readonly state: "saved" }
  | { readonly state: "saving" }
  | { readonly state: "error"; readonly error: PagesError };

export interface PageBody {
  readonly id: PageId;
  /** O(doc). The editor calls it once, on open. */
  spans(): readonly Span[];
  /**
   * Synchronous: one Automerge change, plus a second when inserted text needs
   * its marks corrected; or a thrown `invalid` and no change.
   */
  edit(edits: readonly TextEdit[]): void;
  /** Remote changes only; local edits are not echoed. */
  subscribe(listener: (edits: readonly TextEdit[]) => void): () => void;
  readonly save: View<SaveState>;
  /** Resolves once every change made before the call is stored. */
  flush(): Promise<void>;
  /** Flushes, then drops the doc from memory. */
  close(): Promise<void>;
}

/** What a contender supplies. The caller owns both halves and closes them; the model never does. */
export type PagesStorage = {
  readonly fate: PersistenceStorage;
  readonly bodies: StorageAdapterInterface;
};

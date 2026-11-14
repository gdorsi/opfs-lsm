import type * as Y from "yjs";

type Brand<T, B extends string> = T & { readonly __brand: B };
export type ShapeId = Brand<string, "ShapeId">;
export type BoardId = Brand<string, "BoardId">;
/** A fractional-indexing key. A larger key is in front. Equal keys break by ShapeId. */
export type Z = Brand<string, "Z">;

/** Runs from (x, y) to (x + w, y + h). w and h may be negative. */
export type Box = { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
export type Style = { readonly stroke: string; readonly fill: string | null; readonly strokeWidth: number };
export type Point = { readonly x: number; readonly y: number };

type Common = Box & Style & { readonly id: ShapeId; readonly z: Z };

export type Shape =
  | (Common & { readonly kind: "rect" | "ellipse" | "diamond" })
  | (Common & { readonly kind: "text"; readonly text: string; readonly fontSize: number })
  /** From (x, y) to (x + w, y + h). */
  | (Common & { readonly kind: "arrow" })
  /** Flat x, y pairs as integers 0..65535 of the frame, so a resize only changes x, y, w and h. Written once. */
  | (Common & { readonly kind: "pen"; readonly points: readonly number[] });

export type ShapeKind = Shape["kind"];
export type Shapes = ReadonlyMap<ShapeId, Shape>;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** A shape to create. The board mints the id and the z key. */
export type NewShape = DistributiveOmit<Shape, "id" | "z">;

/** Fields a patch may set. kind and id never change. */
export type ShapeEdit = Readonly<Partial<Box & Style & { z: Z; text: string; fontSize: number }>>;

/**
 * What a command did, as data: the only thing the Y.Doc layer applies and the only thing the oracle replays.
 * A "set" on a missing shape is dropped, so a late edit never undoes a delete.
 */
export type PatchEntry =
  | { readonly op: "put"; readonly shape: Shape }
  | { readonly op: "set"; readonly edit: ShapeEdit }
  | { readonly op: "del" };
export type Patch = ReadonlyMap<ShapeId, PatchEntry>;

export type Direction = "front" | "back" | "forward" | "backward";

export type Command =
  | { readonly type: "create"; readonly shapes: readonly NewShape[] }
  | { readonly type: "move"; readonly ids: readonly ShapeId[]; readonly dx: number; readonly dy: number }
  /** Maps the box `from` onto `to`. Shapes keep their place in the box. Either box may be flipped. */
  | { readonly type: "resize"; readonly ids: readonly ShapeId[]; readonly from: Box; readonly to: Box }
  /** text and fontSize apply to text shapes only. */
  | {
      readonly type: "style";
      readonly ids: readonly ShapeId[];
      readonly edit: Readonly<Partial<Style & { text: string; fontSize: number }>>;
    }
  | { readonly type: "reorder"; readonly ids: readonly ShapeId[]; readonly to: Direction }
  | { readonly type: "duplicate"; readonly ids: readonly ShapeId[]; readonly dx: number; readonly dy: number }
  | { readonly type: "remove"; readonly ids: readonly ShapeId[] };

/** An empty patch means nothing was written and no undo step exists. */
export type Applied = { readonly patch: Patch; readonly created: readonly ShapeId[] };

export type Viewport = { readonly x: number; readonly y: number; readonly zoom: number };

/**
 * A new object whenever anything changes, so it works with useSyncExternalStore. `shapes` is the board's live map,
 * updated in place: read it again after the view changes, and never keep it across a dispatch.
 */
export type BoardView = {
  readonly id: BoardId;
  readonly shapes: Shapes;
  /** Back to front: sorted by (z, id). A new array only when a z, a create or a delete changed it. */
  readonly order: readonly ShapeId[];
  /** Only ids that exist in `shapes`. Local to this tab. */
  readonly selection: ReadonlySet<ShapeId>;
  readonly viewport: Viewport;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  /** Stored shape records that failed parsing and were left out. */
  readonly skipped: number;
};

export interface Board {
  readonly id: BoardId;
  view(): BoardView;
  subscribe(listener: () => void): () => void;

  /** One Y transaction, one Yjs update, one undo step. Unknown ids are skipped. */
  dispatch(command: Command): Applied;
  select(ids: Iterable<ShapeId>): void;
  setViewport(viewport: Viewport): void;
  /** Reverts this board's own last command. Never another tab's. */
  undo(): boolean;
  redo(): boolean;

  /** Resolves when every update so far is acked by storage. Rejects with the storage error. */
  flush(): Promise<void>;
  close(): Promise<void>;
}

/**
 * The only door to storage. The contract, run against every adapter:
 *  1. attach resolves after the stored updates are applied to `doc` with an origin that is not the model's.
 *  2. After attach, every later update of `doc`, whatever its origin, is stored once.
 *  3. flush resolves after every update so far is acked, and rejects if any write failed.
 *  4. detach flushes, then stops listening.
 *  5. clear detaches and deletes every stored update of docName. Idempotent.
 */
export interface DocStorage {
  attach(docName: string, doc: Y.Doc): Promise<DocBinding>;
}

export interface DocBinding {
  flush(): Promise<void>;
  detach(): Promise<void>;
  clear(): Promise<void>;
}

/** Everything nondeterministic, so tests and bench replay exactly. */
export type Env = {
  /** A fresh id. 12 base36 characters by default. */
  id(): string;
};

export type BoardOptions = {
  id: BoardId;
  storage: DocStorage;
  env?: Env;
};

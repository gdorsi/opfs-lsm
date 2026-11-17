/**
 * The goal contract, shared by every dataset. A dataset declares a spec map
 * (goal name -> params and answer); the store interface, the oracle and the
 * goal metadata are mapped types over it, so a goal missing from a
 * contender, the oracle or the metadata is a compile error.
 *
 * Nothing here touches a browser or Node API.
 */
import type { SizeName } from "./types.ts";

export type Json = null | boolean | number | string | readonly Json[] | { readonly [k: string]: Json };
export type JsonRow = { readonly [field: string]: Json };

/** One goal: what it takes and what it answers. The spec fixes every order and limit, so answers compare by deep equality. */
export type GoalSpec = { readonly params: JsonRow; readonly answer: Json };
export type GoalSpecMap = { readonly [goal: string]: GoalSpec };

/** What a contender implements: one async method per goal, written with its own library's query API. */
export type Goals<S extends GoalSpecMap> = {
  readonly [K in keyof S]: (params: S[K]["params"]) => Promise<S[K]["answer"]>;
};

/** The oracle's goals: synchronous, over plain Maps, written as the spec's text reads. */
export type OracleGoals<S extends GoalSpecMap> = {
  readonly [K in keyof S]: (params: S[K]["params"]) => S[K]["answer"];
};

/** The store a goal family's contenders expose to the workload. */
export type GoalStore<S extends GoalSpecMap, Tx> = {
  /** One transaction of the history, through the library's own write API. */
  apply(tx: Tx): Promise<void>;
  readonly goals: Goals<S>;
};

/** The oracle a dataset provides. It shares no code with any contender. */
export interface Oracle<S extends GoalSpecMap, Tx> {
  apply(tx: Tx): void;
  readonly goals: OracleGoals<S>;
  /** JSON bytes of every live row: the Space-Amp denominator. */
  liveBytes(): number;
}

/** Deterministic binding choice, seeded per (dataset, goal): the same for every rep and contender. */
export type Picker = {
  /**
   * `n` distinct items whose cost is nearest the `q` quantile of all costs,
   * ties by `key`. LDBC-style curation: the bindings of one goal do
   * comparable work, so cold, first and warm do not mix cost classes.
   */
  near<T>(items: Iterable<T>, by: { cost(t: T): number; key(t: T): string; n: number; q: number }): T[];
  rng(): number;
};

/** Per goal: the access pattern it owns, printed in the title, and how its bindings are picked from the oracle. */
export type GoalMeta<P extends JsonRow, O> = {
  readonly owns: string;
  /** 1 to 5 bindings from the oracle's state after the history. The first is the cold one. */
  curate(oracle: O, pick: Picker): readonly P[];
};
export type GoalMetas<S extends GoalSpecMap, O> = { readonly [K in keyof S]: GoalMeta<S[K]["params"], O> };

export type Call<S extends GoalSpecMap> = { [K in keyof S & string]: { readonly goal: K; readonly params: S[K]["params"] } }[keyof S & string];

/** One write and the goal reads that must show it at once. */
export type Reread<S extends GoalSpecMap, Tx> = { readonly tx: Tx; readonly reads: readonly Call<S>[] };

/** What the workload asks of a history: an aging part, replayed then settled, and a recent part written on top. */
export type History<Tx> = {
  readonly load: Iterable<Tx>;
  /** Continues the same simulation after `load` is exhausted. */
  recent(): Iterable<Tx>;
};

/** Everything dataset-specific the generic workload needs. One object per dataset. */
export type Dataset<S extends GoalSpecMap, Tx, O extends Oracle<S, Tx>> = {
  readonly title: string;
  readonly seed: number;
  /** The main entity's count per size, for the setup line. */
  readonly entries: Readonly<Record<SizeName, number>>;
  /** Deterministic in (size, seed). */
  history(size: SizeName, seed: number): History<Tx>;
  /** Timing op of a transaction ("import", "sync", "bulk", "edit"), its op count and user bytes. */
  txOp(tx: Tx): string;
  txCount(tx: Tx): number;
  txBytes(tx: Tx): number;
  oracle(): O;
  readonly goals: GoalMetas<S, O>;
  /**
   * A read the replay makes after every `every`th batch whose op is `during`,
   * as a list on screen re-queries while a large sync lands. It is timed as
   * op "read" and not counted in the replay's ops.
   */
  readonly duringLoad: { readonly during: string; readonly every: number; readonly read: Call<S> };
  /** A write after the goals ran, and the reads that must show it. */
  reread(oracle: O): Reread<S, Tx>;
};

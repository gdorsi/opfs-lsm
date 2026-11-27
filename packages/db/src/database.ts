import type { JsonDoc } from "./schema.js";

export interface Collection<T extends JsonDoc, In = T> {
  readonly name: string;
  get(id: string): Promise<T | undefined>;
  insert(docs: In | readonly In[]): Promise<void>;
  upsert(docs: In | readonly In[]): Promise<void>;
  update(id: string, fn: (draft: Draft<T>) => void): Promise<T>;
  delete(ids: string | readonly string[]): Promise<void>;
}

/** A document an `update` callback may change in place. */
export type Draft<T> = { -readonly [K in keyof T]: T[K] };

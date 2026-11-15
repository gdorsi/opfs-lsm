import type { Stream } from "../domain/stores.ts";
import type { DetailResponse, PullResponse, PushOp, PushResponse, RowResponse } from "../domain/wire.ts";

/** The server answered with an error status. A 4xx is a refusal: retrying the same request gets the same answer. */
export class TransportError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** The server as the model sees it. A call that cannot reach the server rejects with another error. */
export interface Transport {
  /** Author of the rows this client creates, and of its pushes. */
  readonly user: string;
  pull<S extends Stream>(stream: S, after: number, limit: number): Promise<PullResponse<S>>;
  push(ops: readonly PushOp[]): Promise<PushResponse>;
  detail(issues: readonly string[]): Promise<DetailResponse>;
  row<S extends Stream>(stream: S, id: string): Promise<RowResponse<S>>;
  /** Calls `hint` with each head the server announces. */
  watch(hint: (head: number) => void): () => void;
  /** Calls `back` each time the network comes back. */
  online(back: () => void): () => void;
}

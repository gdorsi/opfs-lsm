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

/** The server as sync sees it. A call that cannot reach the server rejects with another error. */
export interface Transport {
  /** Author of the rows this client creates, and of its pushes. */
  readonly user: string;
  pull<S extends Stream>(stream: S, after: number, limit: number): Promise<PullResponse<S>>;
  push(ops: readonly PushOp[]): Promise<PushResponse>;
  detail(issues: readonly string[]): Promise<DetailResponse>;
  row<S extends Stream>(stream: S, id: string): Promise<RowResponse<S>>;
  /** Calls `hint` with each head the server announces, and with `undefined` when the network comes back. */
  watch(hint: (head: number | undefined) => void): () => void;
}

/** The app's server, at this page's origin. */
export function httpTransport(user: string): Transport {
  async function request<T>(url: string, body?: unknown): Promise<T> {
    const res = await fetch(url, {
      method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json", "x-linearlite-user": user },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new TransportError(res.status, `${url}: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }
  return {
    user,
    pull: (stream, after, limit) => request(`/api/pull?stream=${stream}&after=${after}&limit=${limit}`),
    push: (ops) => request("/api/push", { ops }),
    detail: (issues) => request(`/api/detail?${issues.map((id) => `id=${encodeURIComponent(id)}`).join("&")}`),
    row: (stream, id) => request(`/api/row?stream=${stream}&id=${encodeURIComponent(id)}`),
    watch(hint) {
      const online = () => hint(undefined);
      addEventListener("online", online);
      const events = new EventSource("/api/events");
      events.onmessage = (e: MessageEvent<string>) => hint((JSON.parse(e.data) as { head: number }).head);
      return () => {
        removeEventListener("online", online);
        events.close();
      };
    },
  };
}

import { TransportError, type Transport } from "../model/transport.ts";

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
      const events = new EventSource("/api/events");
      events.onmessage = (e: MessageEvent<string>) => hint((JSON.parse(e.data) as { head: number }).head);
      return () => events.close();
    },
    online(back) {
      addEventListener("online", back);
      return () => removeEventListener("online", back);
    },
  };
}

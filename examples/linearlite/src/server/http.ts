import { WireError } from "../domain/wire.ts";

export async function respond(run: () => unknown): Promise<Response> {
  try {
    return Response.json(await run(), { headers: { "cache-control": "no-store" } });
  } catch (e) {
    if (e instanceof WireError) return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }
}

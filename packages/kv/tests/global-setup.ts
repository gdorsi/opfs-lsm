import { ensureChecked } from "../checked/build.ts";

/** The engine's checked builds, made once before the workers start when the source changed. */
export default async function setup(): Promise<void> {
  if (!process.env.KV_CHECKED_DIR) await ensureChecked();
}

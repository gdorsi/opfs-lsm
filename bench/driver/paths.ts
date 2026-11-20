import path from "node:path";
import { fileURLToPath } from "node:url";

/** The bench/ directory. Lives apart from build.ts so a command that never builds does not load Vite. */
export const BENCH_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

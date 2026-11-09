import { defineContender } from "../../core/types.ts";
import kv from "./kv.ts";

/** kv unchanged; the runner serves the Zig engine module for this contender (driver/engines.ts). */
export default defineContender({ ...kv, fastPath: `${kv.fastPath}; engine = Zig wasm` });

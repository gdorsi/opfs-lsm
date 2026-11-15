import { defineContender } from "../../core/types.ts";
import { memoryPagesStorage } from "../../../examples/pages-fate-automerge/src/storage/memory.ts";

export default defineContender({
  family: "pages",
  durability: "none",
  fastPath:
    "the floor, not a database: fate and body storage in Maps, fate's exclusive a per-name promise chain; a contender minus this row is what its storage costs",
  engine: false,
  async open() {
    return { storage: memoryPagesStorage(), volatile: true, settle: async () => {}, stats: async () => undefined, close: async () => {} };
  },
});

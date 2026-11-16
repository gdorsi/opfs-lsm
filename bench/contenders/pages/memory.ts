import { defineContender } from "../../core/types.ts";
import { memoryStorage } from "../../../examples/notes-manager-automerge/src/storage/memory.ts";

export default defineContender({
  family: "pages",
  durability: "none",
  fastPath: "the floor, not a database: the list doc and the bodies in a Map; a contender minus this row is what its storage costs",
  engine: false,
  async open() {
    return { storage: memoryStorage(), volatile: true, settle: async () => {}, stats: async () => undefined, close: async () => {} };
  },
});

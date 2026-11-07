import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const readmePath = join(root, "README.md");

if (!existsSync(readmePath)) {
  console.error("README.md is missing");
  process.exit(1);
}

const text = readFileSync(readmePath, "utf8");
const required = ["openDb", "ack", "Dexie", "pnpm test", "pnpm bench"];
const missing = required.filter((phrase) => !text.includes(phrase));

if (missing.length > 0) {
  console.error(`README.md is missing: ${missing.join(", ")}`);
  process.exit(1);
}

console.log(`README.md contains ${required.join(", ")}`);

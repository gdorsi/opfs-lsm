/** Facts about the machine, recorded with every run (LevelDB-style setup line). */
import { execFileSync } from "node:child_process";
import os from "node:os";
import type { HostInfo } from "../core/types.ts";

/** The commit of the checkout, with `-dirty` when the tree has uncommitted changes. */
export function gitStamp(): string {
  try {
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim();
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return "unknown"; // not a git checkout
  }
}

export function hostInfo(chrome: string, headless: boolean, gitSha: string): HostInfo {
  return {
    chrome,
    headless,
    os: `${os.type()} ${os.release()} ${os.arch()}`,
    cpu: os.cpus()[0]?.model ?? "unknown",
    cores: os.cpus().length,
    loadAvg1: Number(os.loadavg()[0]?.toFixed(2)),
    node: process.version,
    gitSha,
  };
}

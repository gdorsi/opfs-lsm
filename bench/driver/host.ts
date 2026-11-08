/** Facts about the machine, recorded with every run (LevelDB-style setup line). */
import { execFileSync } from "node:child_process";
import os from "node:os";
import type { HostInfo } from "../core/types.ts";

export function hostInfo(chrome: string, headless: boolean): HostInfo {
  let gitSha = "unknown";
  try {
    gitSha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim();
    if (dirty) gitSha += "-dirty";
  } catch {
    // not a git checkout
  }
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

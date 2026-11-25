import path from "node:path";
import { build } from "esbuild";
import { afterEach, describe, expect, it } from "vitest";
import { StorageUnavailableError } from "../src/errors.js";
import { EngineHost } from "../src/host/engine-host.js";
import { attachEngineHostPort, createPortIngestClient, MemoryFs } from "../src/testing.js";

const SRC = path.resolve(import.meta.dirname, "../src");

/** The source files that put bytes into the bundle of `entry`. */
async function bundled(entry: string): Promise<string[]> {
  const { metafile } = await build({
    entryPoints: [path.join(SRC, entry)],
    bundle: true,
    write: false,
    metafile: true,
    format: "esm",
    outdir: "out",
    logLevel: "silent",
  });
  return Object.values(metafile.outputs).flatMap((out) =>
    Object.entries(out.inputs)
      .filter(([, input]) => input.bytesInOutput > 0)
      .map(([file]) => path.basename(file)),
  );
}

const ports: MessagePort[] = [];
afterEach(() => {
  for (const port of ports.splice(0)) port.close();
});

describe("the SharedWorker an app loads", () => {
  it("bundles no meter", async () => {
    const files = await bundled("host/shared-worker.ts");
    expect(files).toContain("engine-host.ts");
    expect(files).not.toContain("counting-fs.ts");
    expect(files).not.toContain("metered-host.ts");
  });

  it("the testing one does", async () => {
    expect(await bundled("host/metered-worker.ts")).toContain("counting-fs.ts");
  });

  it("rejects a stats request", async () => {
    const { port1, port2 } = new MessageChannel();
    ports.push(port1, port2);
    attachEngineHostPort(port1, new EngineHost(() => new MemoryFs()));
    await expect(createPortIngestClient(port2).stats("db")).rejects.toBeInstanceOf(StorageUnavailableError);
  });
});

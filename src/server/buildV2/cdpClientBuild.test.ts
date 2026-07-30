import * as esbuild from "esbuild";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { discoverPackageGraph } from "./packageGraph.js";
import { setBuildSourceProvider, workingTreeSourceProvider } from "./buildSource.js";

beforeAll(() => setBuildSourceProvider(workingTreeSourceProvider()));
afterAll(() => setBuildSourceProvider(null));

describe("canonical CDP client build", () => {
  it("keeps the canonical CDP client free of any vendored browser engine", () => {
    const workspaceRoot = path.resolve("workspace");
    const graph = discoverPackageGraph(workspaceRoot);
    const client = graph.get("@workspace/cdp-client");

    expect(client.dependencies).not.toHaveProperty("@workspace/playwright-core");
    expect(client.internalDeps).not.toContain("@workspace/playwright-core");
  });

  it("builds the canonical CDP client standalone (no vendored engine, exports CdpConnection)", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-cdp-client-"));
    try {
      const outfile = path.join(tempDir, "bundle.js");
      await esbuild.build({
        entryPoints: [path.resolve("workspace/packages/cdp-client/src/index.ts")],
        outfile,
        bundle: true,
        format: "esm",
        platform: "browser",
        conditions: ["vibestudio-panel", "browser", "import", "default"],
        logLevel: "silent",
      });

      const bundle = fs.readFileSync(outfile, "utf-8");
      expect(bundle).not.toContain("playwright");
      expect(bundle).toContain("CdpConnection");
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }, 30_000);
});

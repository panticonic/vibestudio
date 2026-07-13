import { describe, expect, it } from "vitest";
import * as esbuild from "esbuild";
import path from "node:path";
import { generateConnectGrammar } from "../scripts/generate-connect-grammar.mjs";

describe("raw-node pairing grammar artifact", () => {
  it("is generated from the canonical shared TypeScript source", async () => {
    await expect(generateConnectGrammar({ check: true })).resolves.toBeUndefined();
  });

  it("loads with the raw-node exports used by pairing scripts", async () => {
    const grammar = await import("../scripts/cli/lib/connect-grammar.generated.mjs");
    expect(grammar).toMatchObject({
      DEFAULT_SIGNAL_URL: expect.any(String),
      createConnectDeepLink: expect.any(Function),
      parseConnectLink: expect.any(Function),
      parseSignalingEndpoint: expect.any(Function),
    });
  });

  it("resolves every local import in the raw-node pairing entrypoints", async () => {
    await expect(
      esbuild.build({
        entryPoints: [
          path.resolve("scripts/dev-webrtc-remote.mjs"),
          path.resolve("scripts/desktop-pairing-smoke.mjs"),
          path.resolve("scripts/cli-remote-smoke.mjs"),
        ],
        bundle: true,
        format: "esm",
        platform: "node",
        packages: "external",
        outdir: "import-resolution-check",
        write: false,
        logLevel: "silent",
      })
    ).resolves.toBeDefined();
  });
});

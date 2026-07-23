import { describe, expect, it } from "vitest";
import type { Metafile } from "esbuild";
import { createPanelBundleReport } from "./panelBundleReport.js";

describe("createPanelBundleReport", () => {
  it("separates the initial static closure from dynamic outputs and excludes maps", () => {
    const sizes = {
      "dist/bundle-A.js": Buffer.byteLength("entry"),
      "dist/chunk-static.js": Buffer.byteLength("static"),
      "dist/chunk-lazy.js": Buffer.byteLength("lazy"),
      "dist/bundle-A.css": Buffer.byteLength("css"),
      "dist/bundle-A.js.map": Buffer.byteLength("debug"),
    };
    const metafile: Metafile = {
      inputs: {},
      outputs: {
        "dist/bundle-A.js": {
          bytes: sizes["dist/bundle-A.js"],
          inputs: {},
          imports: [
            { path: "./chunk-static.js", kind: "import-statement", external: false },
            { path: "./chunk-lazy.js", kind: "dynamic-import", external: false },
          ],
          exports: [],
          entryPoint: "src/entry.ts",
        },
        "dist/chunk-static.js": {
          bytes: sizes["dist/chunk-static.js"],
          inputs: {},
          imports: [],
          exports: [],
        },
        "dist/chunk-lazy.js": {
          bytes: sizes["dist/chunk-lazy.js"],
          inputs: {},
          imports: [],
          exports: [],
        },
        "dist/bundle-A.css": {
          bytes: sizes["dist/bundle-A.css"],
          inputs: {},
          imports: [],
          exports: [],
          entryPoint: "src/entry.ts",
        },
        "dist/bundle-A.js.map": {
          bytes: sizes["dist/bundle-A.js.map"],
          inputs: {},
          imports: [],
          exports: [],
        },
      },
    };

    const report = createPanelBundleReport(metafile, "dist/bundle-A.js", "dist/bundle-A.css");

    expect(report).toMatchObject({
      mode: "report-only",
      initialArtifacts: ["dist/bundle-A.css", "dist/bundle-A.js", "dist/chunk-static.js"],
      initial: {
        requests: 3,
        jsBytes: Buffer.byteLength("entrystatic"),
        cssBytes: Buffer.byteLength("css"),
      },
      lazy: {
        requests: 1,
        jsBytes: Buffer.byteLength("lazy"),
      },
      total: {
        requests: 4,
      },
      largestJsChunkBytes: Buffer.byteLength("static"),
      largestInitialInputs: [],
      largestLazyInputs: [],
    });
  });
});

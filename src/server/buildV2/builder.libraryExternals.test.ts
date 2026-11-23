import { afterEach, describe, it, expect, vi } from "vitest";
import {
  canonicalLibraryExternals,
  computeBuildUnitKey,
  buildNpmLibrary,
  buildPlatformLibrary,
} from "./builder.js";

// Keep the unrelated host artifact generation fixed while exercising real key producers.
vi.mock("./panelEntryProtocol.js", () => ({
  panelEntryProtocolFingerprint: () => "fixed-test-panel-protocol",
}));

const root = { value: "exact-host-dependencies" } as never;
const node = {
  name: "@workspace/fixture",
  kind: "package",
  manifest: {},
  relativePath: "packages/fixture",
} as never;
const ordered = ["@workspace/runtime", "node:util", "util", "node:crypto"];
const reordered = ["util", "node:crypto", "@workspace/runtime", "node:util", "util"];
const key = (externals: string[]) => computeBuildUnitKey(root, node, "exact-ev", {
  library: true,
  libraryTarget: "worker",
  libraryEntrySubpath: "./nested",
  externals,
});

afterEach(() => vi.unstubAllEnvs());

describe("library external identity", () => {
  it("shares workspace keys across insertion order and duplicates while retaining distinct aliases", () => {
    expect(key(ordered)).toBe(key(reordered));
    expect(key(ordered)).not.toBe(key(ordered.filter(name => name !== "util")));
    expect(canonicalLibraryExternals(reordered)).toEqual([
      "@workspace/runtime", "node:crypto", "node:util", "util",
    ]);
    expect(reordered).toHaveLength(5);
  });

  it.each(["npm", "platform"] as const)("shares %s cache lookup identity for equal external sets", async (kind) => {
    const keys: string[] = [];
    const cached = { buildKey: "retained" };
    const session = {
      rootFingerprint: root,
      processOwner: { appNodeModules: ["/installed"] },
      store: {
        getOrHydrate: async (key: string) => {
          keys.push(key);
          return cached;
        },
      },
    } as never;
    for (const externals of [ordered, reordered]) {
      const result = kind === "npm"
        ? await buildNpmLibrary(session, "example", "1.0.0", externals)
        : await buildPlatformLibrary(session, "@vibestudio/shared", externals);
      expect(result).toBe(cached);
    }
    expect(keys[0]).toBe(keys[1]);
  });

  it("retains an explicit old-identity opt-out for diagnosis", () => {
    vi.stubEnv("VIBESTUDIO_CANONICAL_LIBRARY_EXTERNALS", "0");
    expect(key(ordered)).not.toBe(key(reordered));
    const captured = canonicalLibraryExternals(reordered);
    expect(captured).toEqual(reordered);
    expect(captured).not.toBe(reordered);
  });
});

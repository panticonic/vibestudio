import { describe, expect, it } from "vitest";
import { resolveExportSubpath } from "./workspace-packages.js";

describe("resolveExportSubpath", () => {
  it("resolves exact export keys before patterns", () => {
    const exports = {
      "./tests/*": "./tests/*.ts",
      "./tests/special": "./special.ts",
    };

    expect(resolveExportSubpath(exports, "./tests/special", ["default"])).toBe("./special.ts");
  });

  it("substitutes package export wildcard matches into the target", () => {
    const exports = { "./tests/*": "./tests/*.ts" };

    expect(resolveExportSubpath(exports, "./tests/workers", ["default"])).toBe(
      "./tests/workers.ts"
    );
    expect(resolveExportSubpath(exports, "./tests/nested/probe", ["default"])).toBe(
      "./tests/nested/probe.ts"
    );
  });

  it("resolves conditional wildcard targets and prefers the most-specific pattern", () => {
    const exports = {
      "./*": { worker: "./worker/*.ts", default: "./default/*.ts" },
      "./features/*": { worker: "./worker/features/*.ts" },
    };

    expect(resolveExportSubpath(exports, "./features/a", ["worker", "default"])).toBe(
      "./worker/features/a.ts"
    );
    expect(resolveExportSubpath(exports, "./other", ["default"])).toBe("./default/other.ts");
  });

  it("does not fall back when the most-specific matching pattern blocks the subpath", () => {
    const exports = {
      "./*": "./fallback/*.ts",
      "./private/*": null,
    };

    expect(resolveExportSubpath(exports, "./private/secret", ["default"])).toBeNull();
  });

  it("honors explicit conditional restrictions before default exports", () => {
    const exports = {
      ".": { worker: null, default: "./host.ts" },
      "./nested": { worker: { import: null }, default: "./host.ts" },
    };
    expect(resolveExportSubpath(exports, ".", ["worker", "default"])).toBeNull();
    expect(resolveExportSubpath(exports, "./nested", ["worker", "import", "default"])).toBeNull();
    expect(resolveExportSubpath(exports, ".", ["node", "default"])).toBe("./host.ts");
  });

  it("continues past a nested condition tree with no matching condition", () => {
    expect(
      resolveExportSubpath(
        { ".": { worker: { require: "./require.ts" }, default: "./fallback.ts" } },
        ".",
        ["worker", "import", "default"]
      )
    ).toBe("./fallback.ts");
  });

  it("resolves standard root export forms without exposing unexported subpaths", () => {
    for (const root of [
      "./entry.js",
      { node: "./entry.js", default: null },
      [null, "./entry.js"],
    ]) {
      expect(resolveExportSubpath(root, ".", ["node"])).toBe("./entry.js");
      expect(resolveExportSubpath(root, "./private", ["node"])).toBeNull();
    }
    expect(resolveExportSubpath(null, ".", ["default"])).toBeNull();
  });

  it("honors the package's declaration order among matching conditions", () => {
    expect(
      resolveExportSubpath({ ".": { import: "./esm.js", worker: "./worker.js" } }, ".", [
        "worker",
        "import",
      ])
    ).toBe("./esm.js");
    expect(
      resolveExportSubpath({ ".": { default: null, node: "./node.js" } }, ".", ["node", "default"])
    ).toBeNull();
  });

  it("returns null when no exact key or wildcard matches", () => {
    expect(
      resolveExportSubpath({ "./tests/*": "./tests/*.ts" }, "./src/workers", ["default"])
    ).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { resolveExportSubpath } from "./workspace-packages.js";

describe("resolveExportSubpath", () => {
  it("resolves exact export keys before patterns", () => {
    const exports = {
      "./tests/*": "./tests/*.ts",
      "./tests/special": "./special.ts",
    };

    expect(resolveExportSubpath(exports, "./tests/special", ["default"])).toBe(
      "./special.ts"
    );
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

  it("returns null when no exact key or wildcard matches", () => {
    expect(
      resolveExportSubpath({ "./tests/*": "./tests/*.ts" }, "./src/workers", ["default"])
    ).toBeNull();
  });
});

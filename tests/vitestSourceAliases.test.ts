import path from "node:path";
import { describe, expect, it } from "vitest";
import { workspaceSourceAliases } from "../vitest.sourceAliases";

describe("workspaceSourceAliases", () => {
  it("resolves tsconfig path targets from the config directory", () => {
    const repoRoot = path.resolve(import.meta.dirname, "..");
    const aliases = workspaceSourceAliases(repoRoot);
    const durable = aliases.find((alias) => alias.find === "@vibestudio/durable");

    expect(durable).toEqual({
      find: "@vibestudio/durable",
      replacement: path.resolve(repoRoot, "packages/durable/src/index.ts"),
    });
  });
});

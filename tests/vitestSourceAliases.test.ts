import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { hostSourceAliases } from "../vitest.sourceAliases";

const roots: string[] = [];

function baseFixture(paths: Record<string, string[]>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-alias-base-"));
  roots.push(root);
  fs.writeFileSync(
    path.join(root, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { paths } })
  );
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("hostSourceAliases", () => {
  it("resolves tsconfig path targets from the config directory", () => {
    const baseRoot = baseFixture({ "@vibestudio/durable": ["./packages/durable/src/index.ts"] });
    const aliases = hostSourceAliases(baseRoot);
    const durable = aliases.find((alias) => alias.find === "@vibestudio/durable");

    expect(durable).toEqual({
      find: "@vibestudio/durable",
      replacement: path.resolve(baseRoot, "packages/durable/src/index.ts"),
    });
  });

  it("does not expose declaration-only TypeScript paths as runtime aliases", () => {
    const baseRoot = baseFixture({
      "@workspace/cdp-client": ["packages/cdp-client/index.d.ts"],
    });
    const aliases = hostSourceAliases(baseRoot);

    expect(aliases).not.toContainEqual({
      find: "@workspace/cdp-client",
      replacement: path.resolve(baseRoot, "packages/cdp-client/index.d.ts"),
    });
    expect(
      aliases.some(
        (alias) => typeof alias.replacement === "string" && /\.d\.[cm]?ts$/.test(alias.replacement)
      )
    ).toBe(false);
  });
});

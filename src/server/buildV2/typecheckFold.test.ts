import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";
import { typecheckUnit } from "./typecheckFold.js";

/**
 * The push build-gate type-checks a unit against a BARE materialized source root
 * (the unit + its workspace-dep source subtrees — no node_modules, no
 * pnpm-workspace.yaml). These tests pin that `typecheckUnit` provisions module
 * resolution explicitly so `@workspace/*` (materialized subtree) AND external
 * deps (`node_modules`) resolve — the regression where it resolved NOTHING and
 * reported "Cannot find module" for every import would block all panel pushes.
 */
describe("typecheckUnit (push build-gate fold-in)", () => {
  let sourceRoot: string;
  let nodeModules: string;

  beforeAll(async () => {
    sourceRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "tcfold-src-"));
    nodeModules = await fsp.mkdtemp(path.join(os.tmpdir(), "tcfold-nm-"));

    // Unit under test: imports a workspace dep AND an external npm dep.
    await fsp.mkdir(path.join(sourceRoot, "panels/hello"), { recursive: true });
    await fsp.writeFile(
      path.join(sourceRoot, "panels/hello/package.json"),
      JSON.stringify({ name: "@workspace-panels/hello", type: "module" })
    );
    await fsp.writeFile(
      path.join(sourceRoot, "panels/hello/index.ts"),
      [
        `import { greet } from "@workspace/greeter";`,
        `import { extValue } from "ext-pkg";`,
        `export const message: string = greet(extValue);`,
      ].join("\n")
    );

    // Workspace dep, materialized as a source subtree — types come from its
    // `exports` pointing at source (exactly how real workspace packages ship).
    await fsp.mkdir(path.join(sourceRoot, "packages/greeter/src"), { recursive: true });
    await fsp.writeFile(
      path.join(sourceRoot, "packages/greeter/package.json"),
      JSON.stringify({
        name: "@workspace/greeter",
        type: "module",
        exports: { ".": "./src/index.ts" },
      })
    );
    await fsp.writeFile(
      path.join(sourceRoot, "packages/greeter/src/index.ts"),
      `export const greet = (who: string): string => "hi " + who;`
    );

    // External npm dep, resolvable only via an explicit node_modules root.
    await fsp.mkdir(path.join(nodeModules, "ext-pkg"), { recursive: true });
    await fsp.writeFile(
      path.join(nodeModules, "ext-pkg/package.json"),
      JSON.stringify({ name: "ext-pkg", version: "1.0.0", types: "index.d.ts" })
    );
    await fsp.writeFile(
      path.join(nodeModules, "ext-pkg/index.d.ts"),
      `export declare const extValue: string;`
    );
  });

  afterAll(async () => {
    await fsp.rm(sourceRoot, { recursive: true, force: true });
    await fsp.rm(nodeModules, { recursive: true, force: true });
  });

  const deps = [
    { name: "@workspace-panels/hello", relativePath: "panels/hello" },
    { name: "@workspace/greeter", relativePath: "packages/greeter" },
  ];

  it("resolves @workspace/* (materialized subtree) and external deps (node_modules) — no false 'Cannot find module'", async () => {
    const diags = await typecheckUnit("panels/hello", sourceRoot, deps, [nodeModules]);
    const cannotFind = diags.filter((d) => /Cannot find module/.test(d.message));
    expect(cannotFind).toEqual([]);
  });

  it("WITHOUT provisioning (the bug), the same unit reports 'Cannot find module' for both", async () => {
    // No workspace context (empty deps) + no node_modules → nothing resolves.
    const diags = await typecheckUnit("panels/hello", sourceRoot, [], []);
    const messages = diags.map((d) => d.message).join("\n");
    expect(messages).toMatch(/Cannot find module ['"]@workspace\/greeter['"]/);
    expect(messages).toMatch(/Cannot find module ['"]ext-pkg['"]/);
  });

  it("reports typecheck files in workspace-relative coordinates", async () => {
    const brokenPath = path.join(sourceRoot, "panels/hello/broken.ts");
    await fsp.writeFile(brokenPath, `export const count: number = "wrong";`);
    try {
      const diags = await typecheckUnit("panels/hello", sourceRoot, deps, [nodeModules]);
      expect(diags).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            source: "tsc",
            file: "panels/hello/broken.ts",
          }),
        ])
      );
    } finally {
      await fsp.rm(brokenPath, { force: true });
    }
  });
});

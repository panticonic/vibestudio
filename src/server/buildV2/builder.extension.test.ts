import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setUserDataPath } from "@vibestudio/env-paths";

import { buildUnit } from "./builder.js";
import { sealBuildEnvironment } from "./sourceClosure.js";
import { setBuildSourceProvider, workingTreeSourceProvider } from "./buildSource.js";
beforeAll(() => setBuildSourceProvider(workingTreeSourceProvider()));
afterAll(() => setBuildSourceProvider(null));
import { primaryTextArtifactContent } from "./buildStore.js";
import { discoverPackageGraph } from "./packageGraph.js";

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "ignore", "pipe"],
  });
}

describe("buildUnit extension builds", () => {
  let root: string;
  let workspaceRoot: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-extension-build-"));
    workspaceRoot = path.join(root, "workspace");
    setUserDataPath(path.join(root, "state"));
    sealBuildEnvironment({ appRoot: root, workspaceRoot });
  });

  afterEach(() => {
    sealBuildEnvironment(null);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("builds a workspace extension package as a node ESM bundle with inline sourcemaps", async () => {
    const extensionDir = path.join(workspaceRoot, "extensions", "hello");
    fs.mkdirSync(extensionDir, { recursive: true });
    fs.writeFileSync(
      path.join(extensionDir, "package.json"),
      JSON.stringify({
        name: "@workspace-extensions/hello",
        version: "0.1.0",
        type: "module",
        private: true,
        vibestudio: {
          authority: { requests: [], delegations: [] },
          displayName: "Hello Extension",
          entry: "index.ts",
          sourcemap: true,
          extension: {
            activationEvents: ["*"],
            providerContracts: {
              gitInterop: { methods: ["ping"] },
            },
          },
        },
      })
    );
    fs.writeFileSync(
      path.join(extensionDir, "index.ts"),
      [
        "export async function activate(ctx: any) {",
        "  try {",
        "    await ctx.storage.readFile('missing.json', 'utf8');",
        "    throw new Error('missing storage file unexpectedly existed');",
        "  } catch (error: any) {",
        "    if (error.code !== 'ENOENT') throw error;",
        "  }",
        "  await ctx.storage.writeFile('root-value.txt', 'root');",
        "  if (await ctx.storage.readFile('root-value.txt', 'utf8') !== 'root') {",
        "    throw new Error('smoke storage root did not round-trip');",
        "  }",
        "  await ctx.storage.mkdir('state', { recursive: true });",
        "  await ctx.storage.writeFile('state/value.txt', 'isolated');",
        "  if (await ctx.storage.readFile('state/value.txt', 'utf8') !== 'isolated') {",
        "    throw new Error('smoke storage did not round-trip');",
        "  }",
        "  try {",
        "    ctx.storage.resolvePath('../escape');",
        "    throw new Error('smoke storage accepted an escaping path');",
        "  } catch (error: any) {",
        "    if (error.code !== 'EACCES') throw error;",
        "  }",
        "  return {",
        "    ping() { return 'pong'; },",
        "  };",
        "}",
        "",
      ].join("\n")
    );
    git(extensionDir, ["init", "-b", "main"]);
    git(extensionDir, ["add", "."]);
    git(extensionDir, [
      "-c",
      "user.name=Vibestudio Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "initial extension",
    ]);

    const graph = discoverPackageGraph(workspaceRoot);
    const node = graph.get("@workspace-extensions/hello");
    const result = await buildUnit(
      node,
      "sourceDigest-extension-test",
      graph,
      workspaceRoot,
      "state:test"
    );

    expect(result.metadata).toMatchObject({
      kind: "extension",
      name: "@workspace-extensions/hello",
      sourcemap: true,
      details: {
        kind: "extension",
        runtimeDepsKey: null,
        runtimeAbi: "3",
        providerContracts: {
          gitInterop: { methods: ["ping"] },
        },
      },
    });
    expect(fs.readFileSync(path.join(result.dir, "package.json"), "utf8")).toBe(
      '{"type":"module"}'
    );
    const bundle = primaryTextArtifactContent(result);
    expect(bundle).toContain("ping() {");
    expect(bundle).toContain("sourceMappingURL=data:application/json");
  });

  it("runs bundled CommonJS dependencies from an ESM extension bundle", async () => {
    const extensionDir = path.join(workspaceRoot, "extensions", "cjs-extension");
    fs.mkdirSync(extensionDir, { recursive: true });
    fs.writeFileSync(
      path.join(extensionDir, "package.json"),
      JSON.stringify({
        name: "@workspace-extensions/cjs-extension",
        version: "0.1.0",
        type: "module",
        private: true,
        vibestudio: {
          authority: { requests: [], delegations: [] },
          displayName: "CJS Extension",
          entry: "index.ts",
          sourcemap: true,
          extension: { activationEvents: ["*"] },
        },
      })
    );
    fs.writeFileSync(
      path.join(extensionDir, "cjs-dep.cjs"),
      [
        "const path = require('path');",
        "module.exports = { base: (value) => path.basename(value) };",
        "",
      ].join("\n")
    );
    fs.writeFileSync(
      path.join(extensionDir, "index.ts"),
      [
        "import dep from './cjs-dep.cjs';",
        "export async function activate() {",
        "  return {",
        "    basename(value: string) { return dep.base(value); },",
        "  };",
        "}",
        "",
      ].join("\n")
    );
    git(extensionDir, ["init", "-b", "main"]);
    git(extensionDir, ["add", "."]);
    git(extensionDir, [
      "-c",
      "user.name=Vibestudio Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "initial extension",
    ]);

    const graph = discoverPackageGraph(workspaceRoot);
    const node = graph.get("@workspace-extensions/cjs-extension");
    const result = await buildUnit(
      node,
      "sourceDigest-extension-cjs-test",
      graph,
      workspaceRoot,
      "state:test"
    );
    const mod = await import(`file://${path.join(result.dir, "bundle.js")}`);
    const api = await mod.activate();

    expect(api.basename("/tmp/example.txt")).toBe("example.txt");
  });
});

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setUserDataPath } from "@vibestudio/env-paths";

import { buildUnit } from "./builder.js";
import { setBuildRootConfig } from "./effectiveVersion.js";
import { setBuildSourceProvider, workingTreeSourceProvider } from "./buildSource.js";
beforeAll(() => setBuildSourceProvider(workingTreeSourceProvider()));
afterAll(() => setBuildSourceProvider(null));
import { primaryTextArtifactContent, setBuildExecutionIdentityContext } from "./buildStore.js";
import { discoverPackageGraph } from "./packageGraph.js";
import { EXTENSION_RUNTIME_ABI_VERSION } from "@vibestudio/shared/extensionRuntimeAbi";

const SOURCE_STATE_HASH = `state:${"c".repeat(64)}`;

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "ignore", "pipe"],
  });
}

describe("buildUnit extension builds", () => {
  let root: string;
  let workspaceRoot: string;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-extension-build-"));
    workspaceRoot = path.join(root, "workspace");
    await setBuildRootConfig({
      appRoot: path.resolve(__dirname, "../../.."),
      workspaceRoot,
    });
    setUserDataPath(path.join(root, "state"));
    setBuildExecutionIdentityContext({
      workspaceId: "workspace:test",
      executionStateForContent: (stateHash) => ({ kind: "event", eventId: `event:${stateHash}` }),
    });
  });

  afterEach(async () => {
    await setBuildRootConfig(null);
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
          displayName: "Hello Extension",
          icon: "./assets/icon.svg",
          entry: "index.ts",
          sourcemap: true,
          extension: {
            activationEvents: ["*"],
            methodAuthority: {
              ping: { effect: { kind: "open" } },
            },
            providerContracts: {
              gitInterop: { methods: ["ping"] },
            },
          },
        },
      })
    );
    fs.mkdirSync(path.join(extensionDir, "assets"));
    fs.writeFileSync(
      path.join(extensionDir, "assets", "icon.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="8"/></svg>'
    );
    fs.writeFileSync(
      path.join(extensionDir, "index.ts"),
      [
        "export async function activate(ctx: { storage: { readdir(path: string): Promise<string[]> } }) {",
        "  const entries = await ctx.storage.readdir('launches');",
        "  if (!Array.isArray(entries)) throw new Error('smoke storage readdir contract violated');",
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
    const result = await buildUnit(node, "a".repeat(64), graph, workspaceRoot, SOURCE_STATE_HASH);

    expect(result.metadata).toMatchObject({
      kind: "extension",
      name: "@workspace-extensions/hello",
      sourcemap: true,
      details: {
        kind: "extension",
        runtimeDepsKey: null,
        runtimeAbi: EXTENSION_RUNTIME_ABI_VERSION,
        providerContracts: {
          gitInterop: { methods: ["ping"] },
        },
      },
      authority: {
        provides: [],
        requests: [],
      },
    });
    expect(fs.readFileSync(path.join(result.dir, "package.json"), "utf8")).toBe(
      '{"type":"module"}'
    );
    const bundle = primaryTextArtifactContent(result);
    expect(bundle).toContain("ping() {");
    expect(bundle).toContain("sourceMappingURL=data:application/json");
    expect(result.artifacts).toContainEqual(
      expect.objectContaining({
        path: "assets/icon.svg",
        role: "asset",
        contentType: "image/svg+xml",
      })
    );
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
          displayName: "CJS Extension",
          entry: "index.ts",
          sourcemap: true,
          extension: {
            activationEvents: ["*"],
            methodAuthority: {
              basename: { effect: { kind: "open" } },
            },
          },
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
    const result = await buildUnit(node, "b".repeat(64), graph, workspaceRoot, SOURCE_STATE_HASH);
    const mod = await import(`file://${path.join(result.dir, "bundle.js")}`);
    const api = await mod.activate();

    expect(api.basename("/tmp/example.txt")).toBe("example.txt");
  });
});

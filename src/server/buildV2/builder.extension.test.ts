import { runIsolatedBuildJob } from "./nativeJobTestFixture.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setUserDataPath } from "@vibestudio/env-paths";

import { buildUnit, closeBuilder, extensionRuntimeDepsProjected, initBuilder } from "./builder.js";
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
    initBuilder(path.join(process.cwd(), "node_modules"), process.cwd(), runIsolatedBuildJob);
    root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-extension-build-"));
    workspaceRoot = path.join(root, "workspace");
    await setBuildRootConfig({
      appRoot: path.resolve(__dirname, "../../.."),
      workspaceRoot,
    });
    setUserDataPath(path.join(root, "state"));
    setBuildExecutionIdentityContext({
      serviceAuthorityForSource: async () =>
        "b7e01c5f5a5351d9b1e459b5fc9e3c36920637eac75afd9ad271b3a0d8736e06",
      workspaceId: "workspace:test",
      executionStateForContent: (stateHash) => ({ kind: "event", eventId: `event:${stateHash}` }),
    });
  });

  afterEach(async () => {
    await closeBuilder();
    await setBuildRootConfig(null);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("requires cached runtime dependencies to belong to the build projection", () => {
    const projection = path.join(root, "projection");
    const buildDir = path.join(projection, "build");
    const bundlePath = path.join(buildDir, "bundle.cjs");
    const hostDependency = path.join(projection, "node_modules", "fixture-dependency");
    fs.mkdirSync(hostDependency, { recursive: true });
    fs.writeFileSync(path.join(hostDependency, "package.json"), '{"main":"index.js"}');
    fs.writeFileSync(path.join(hostDependency, "index.js"), "module.exports = 'host';\n");
    fs.mkdirSync(buildDir, { recursive: true });
    fs.writeFileSync(bundlePath, "module.exports = true;\n");

    // Node's ordinary resolver walks from the bundle into the host's node_modules.
    expect(() => createRequire(bundlePath).resolve("fixture-dependency")).not.toThrow();
    expect(extensionRuntimeDepsProjected(bundlePath, ["fixture-dependency"])).toBe(false);

    // Immutable dependency projections preserve links to their content store. The
    // store may live outside the build directory, but its package entry is owned
    // by this build's node_modules projection.
    const storePackage = path.join(root, "dependency-store", "fixture-dependency");
    const projectedDependency = path.join(buildDir, "node_modules", "fixture-dependency");
    fs.mkdirSync(projectedDependency, { recursive: true });
    fs.writeFileSync(path.join(projectedDependency, "package.json"), '{"main":"missing.js"}');
    expect(extensionRuntimeDepsProjected(bundlePath, ["fixture-dependency"])).toBe(false);

    fs.rmSync(projectedDependency, { recursive: true, force: true });
    fs.mkdirSync(storePackage, { recursive: true });
    fs.writeFileSync(path.join(storePackage, "package.json"), '{"main":"index.js"}');
    fs.writeFileSync(path.join(storePackage, "index.js"), "module.exports = 'store';\n");
    fs.mkdirSync(path.dirname(projectedDependency), { recursive: true });
    fs.symlinkSync(storePackage, projectedDependency, "dir");

    expect(extensionRuntimeDepsProjected(bundlePath, ["fixture-dependency"])).toBe(true);
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
              ping: {
                website: { kind: "eligible", rationale: "Explicit extension fixture contract." },
                effect: { kind: "open" },
              },
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
    const bundle = await primaryTextArtifactContent(result);
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
              basename: {
                website: { kind: "eligible", rationale: "Explicit extension fixture contract." },
                effect: { kind: "open" },
              },
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

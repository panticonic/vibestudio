import { runIsolatedBuildJob } from "./nativeJobTestFixture.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  buildUnit,
  type BuilderSession,
  extensionRuntimeDepsProjected,
  materializeExtensionRuntimeDeps,
  populateExtensionRuntimeDeps,
  refreshCachedExtensionRuntimeDeps,
} from "./builder.js";
import { createBuilderTestSession } from "./builderTestSession.js";
import { extensionRuntimeDependencyKey } from "./externalDeps.js";
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
  let session: BuilderSession;
  let closeSession: () => Promise<void>;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-extension-build-"));
    workspaceRoot = path.join(root, "workspace");
    const context = await createBuilderTestSession({
      appRoot: path.resolve(__dirname, "../../.."),
      workspaceRoot,
      stateRoot: path.join(root, "state"),
      runNativeJob: runIsolatedBuildJob,
    });
    session = context.session;
    closeSession = context.close;
  });

  afterEach(async () => {
    await closeSession?.();
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
    expect(extensionRuntimeDepsProjected(bundlePath, ["fixture-dependency"], "fixture-key")).toBe(
      false
    );

    // Immutable dependency projections preserve links to their content store. The
    // store may live outside the build directory, but its package entry is owned
    // by this build's node_modules projection.
    const storePackage = path.join(root, "dependency-store", "fixture-dependency");
    const projectedDependency = path.join(buildDir, "node_modules", "fixture-dependency");
    fs.mkdirSync(projectedDependency, { recursive: true });
    fs.writeFileSync(path.join(projectedDependency, "package.json"), '{"main":"missing.js"}');
    expect(extensionRuntimeDepsProjected(bundlePath, ["fixture-dependency"], "fixture-key")).toBe(
      false
    );

    fs.rmSync(projectedDependency, { recursive: true, force: true });
    fs.mkdirSync(storePackage, { recursive: true });
    fs.writeFileSync(path.join(storePackage, "package.json"), '{"main":"index.js"}');
    fs.writeFileSync(path.join(storePackage, "index.js"), "module.exports = 'store';\n");
    fs.mkdirSync(path.dirname(projectedDependency), { recursive: true });
    fs.symlinkSync(storePackage, projectedDependency, "dir");

    // A resolvable entrypoint alone is not proof that the rest of the tree
    // finished copying; only a receipt written after projection establishes it.
    expect(extensionRuntimeDepsProjected(bundlePath, ["fixture-dependency"], "fixture-key")).toBe(
      false
    );
    fs.writeFileSync(
      path.join(buildDir, "node_modules", ".vibestudio-runtime-projection.json"),
      JSON.stringify({ version: 1, runtimeDepsKey: "fixture-key" })
    );
    expect(extensionRuntimeDepsProjected(bundlePath, ["fixture-dependency"], "wrong-key")).toBe(
      false
    );
    expect(extensionRuntimeDepsProjected(bundlePath, ["fixture-dependency"], "fixture-key")).toBe(
      true
    );
  });

  it("validates a staged dependency closure before publishing it as node_modules", async () => {
    const dep = "@workspace-extensions/fixture-dependency";
    const buildDir = path.join(root, "build");
    const source = path.join(root, "source", "node_modules");
    const stageParent = path.join(buildDir, ".node_modules-staging-test");
    const stage = path.join(stageParent, "node_modules");
    const bundlePath = path.join(buildDir, "bundle.cjs");
    const ancestor = path.join(root, "node_modules", dep);
    fs.mkdirSync(ancestor, { recursive: true });
    fs.writeFileSync(path.join(ancestor, "package.json"), '{"main":"index.js"}');
    fs.writeFileSync(path.join(ancestor, "index.js"), "module.exports = 'ancestor';\n");
    fs.mkdirSync(path.join(source, dep), { recursive: true });
    fs.writeFileSync(path.join(source, dep, "package.json"), '{"main":"index.js"}');
    fs.mkdirSync(stageParent, { recursive: true });
    fs.writeFileSync(bundlePath, "module.exports = true;\n");

    await expect(
      populateExtensionRuntimeDeps(session, stage, source, dep, { [dep]: "1.0.0" }, "key")
    ).rejects.toThrow(/fixture-dependency.*Cannot find module/u);
    expect(extensionRuntimeDepsProjected(bundlePath, [dep], "key")).toBe(false);

    fs.writeFileSync(path.join(source, dep, "index.js"), "module.exports = 'projected';\n");
    fs.rmSync(stage, { recursive: true, force: true });
    await populateExtensionRuntimeDeps(session, stage, source, dep, { [dep]: "1.0.0" }, "key");
    fs.renameSync(stage, path.join(buildDir, "node_modules"));
    expect(extensionRuntimeDepsProjected(bundlePath, [dep], "key")).toBe(true);
    expect(createRequire(bundlePath)(dep)).toBe("projected");

    const replacement = path.join(root, "replacement", "node_modules");
    fs.mkdirSync(path.join(replacement, dep), { recursive: true });
    fs.writeFileSync(path.join(replacement, dep, "package.json"), '{"main":"index.js"}');
    fs.writeFileSync(path.join(replacement, dep, "index.js"), "module.exports = 'replacement';\n");
    await materializeExtensionRuntimeDeps(
      session,
      buildDir,
      replacement,
      dep,
      { [dep]: "2.0.0" },
      "key2"
    );
    expect(extensionRuntimeDepsProjected(bundlePath, [dep], "key2")).toBe(true);
    expect(fs.readFileSync(path.join(buildDir, "node_modules", dep, "index.js"), "utf8")).toContain(
      "replacement"
    );
    expect(
      fs.readdirSync(buildDir).filter((entry) => entry.startsWith(".node_modules-staging-"))
    ).toEqual([".node_modules-staging-test"]);
    expect(
      fs.readdirSync(buildDir).filter((entry) => entry.startsWith("node_modules.previous."))
    ).toEqual([]);
  });

  it("repairs runtime metadata without changing a retained execution or the canonical latest execution", async () => {
    const key = "a".repeat(64);
    const originalState = `state:${"1".repeat(64)}`;
    const latestState = `state:${"2".repeat(64)}`;
    const deps = { fixture: "1.0.0" };
    const runtimeKey = extensionRuntimeDependencyKey(session.processOwner.appRoot, deps)!;
    const original = await session.store.putStored(
      key,
      {
        entries: [
          {
            path: "bundle.js",
            role: "primary",
            contentType: "text/javascript; charset=utf-8",
            encoding: "utf8",
            content: "export default {};",
          },
        ],
      },
      {
        kind: "extension",
        name: "@workspace-extensions/fixture",
        buildKey: key,
        sourcePath: "extensions/fixture",
        ev: "e".repeat(64),
        sourceStateHash: originalState,
        sourcemap: false,
        authority: { requests: [], provides: [] },
        details: {
          kind: "extension",
          runtimeDepsKey: "prior-runtime-key",
          runtimeAbi: null,
          providerContracts: {},
          methodAuthority: {},
          externalDeps: deps,
        },
        builtAt: "2026-01-01T00:00:00.000Z",
      },
      async (directory) => {
        const packageDir = path.join(directory, "node_modules", "fixture");
        await fs.promises.mkdir(packageDir, { recursive: true });
        await fs.promises.writeFile(path.join(packageDir, "package.json"), '{"main":"index.js"}');
        await fs.promises.writeFile(path.join(packageDir, "index.js"), "module.exports = true;");
        await fs.promises.writeFile(
          path.join(directory, "node_modules", ".vibestudio-runtime-projection.json"),
          JSON.stringify({ version: 1, runtimeDepsKey: runtimeKey })
        );
      }
    );
    const originalDigest = original.metadata.execution!.executionDigest;
    const latest = await session.store.rebindSourceState(original, latestState);
    const retained = (await session.store.getByExecution(key, originalDigest))!;
    expect(retained.metadata.execution?.executionDigest).toBe(originalDigest);

    await refreshCachedExtensionRuntimeDeps(session, retained);

    expect(retained.metadata.execution?.executionDigest).toBe(originalDigest);
    expect(retained.sourceStateHash).toBe(originalState);
    expect(retained.metadata.sourceStateHash).toBe(originalState);
    expect(retained.metadata.details).toMatchObject({ runtimeDepsKey: runtimeKey });
    const canonical = await session.store.readBuildMetadata(latest.dir);
    expect(canonical.execution?.executionDigest).toBe(latest.metadata.execution?.executionDigest);
    expect(canonical.sourceStateHash).toBe(latestState);
    expect(canonical.details).toMatchObject({ runtimeDepsKey: runtimeKey });
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
    const result = await buildUnit(
      session,
      node,
      "a".repeat(64),
      graph,
      workspaceRoot,
      SOURCE_STATE_HASH
    );

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
    const bundle = await session.store.primaryTextArtifactContent(result);
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
    const result = await buildUnit(
      session,
      node,
      "b".repeat(64),
      graph,
      workspaceRoot,
      SOURCE_STATE_HASH
    );
    const mod = await import(`file://${path.join(result.dir, "bundle.js")}`);
    const api = await mod.activate();

    expect(api.basename("/tmp/example.txt")).toBe("example.txt");
  });
});

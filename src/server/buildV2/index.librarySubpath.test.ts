import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import vm, { Script } from "node:vm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setUserDataPath } from "@vibestudio/env-paths";
import {
  createPrivateGuestGlobal,
  getRealmCompiler,
  tameRealmCodegen,
} from "@vibestudio/shared/evalConfinement";

import { initBuildSystemV2, type BuildSystemV2 } from "./index.js";
import type { BuildSourceProvider } from "./buildSource.js";
import type { WorkspaceStateSource } from "./stateTrigger.js";
import { discoverPackageGraph } from "./packageGraph.js";
import { exactUserlandRoot } from "../../../tests/exactUserlandRoot";

const APP_NODE_MODULES = [path.resolve(__dirname, "../../../node_modules")];
const requireNodeBuiltin = createRequire(import.meta.url);
const TEST_STATE = `state:${"a".repeat(64)}`;
const CONTEXT_STATE = `state:${"b".repeat(64)}`;
const RESOLVE_CONTEXT_STATE = `state:${"c".repeat(64)}`;

function buildRoots(workspaceRoot: string) {
  return { appRoot: path.resolve(__dirname, "../../.."), dependencyWorkspaceRoot: workspaceRoot };
}

/** Serves the working tree as the (only) workspace state. */
function fakeWorkspaceSource(
  getWorkspaceRoot: () => string
): WorkspaceStateSource & BuildSourceProvider {
  return {
    workspaceId: "workspace:test",
    async ensureFresh() {
      return { stateHash: TEST_STATE };
    },
    async unitHashes(_stateHash, relPaths) {
      return Object.fromEntries(relPaths.map((relPath) => [relPath, `h:${relPath}`]));
    },
    async resolveContextState() {
      return TEST_STATE;
    },
    async readFile() {
      return null;
    },
    executionStateForContent(stateHash) {
      return { kind: "event", eventId: `event:${stateHash}` };
    },
    async discoverGraph() {
      return discoverPackageGraph(getWorkspaceRoot());
    },
    onProtectedPublication() {
      return () => {};
    },
    async recordBuild() {},
    async materializeForBuild() {
      return { sourceRoot: getWorkspaceRoot() };
    },
  };
}

function fakeMultiStateWorkspaceSource(
  stateRoots: Record<string, string>,
  mainStateHash: string,
  heads: Record<string, string> = {}
): WorkspaceStateSource & BuildSourceProvider {
  const rootForState = (stateHash: string): string => {
    const root = stateRoots[stateHash];
    if (!root) throw new Error(`No fake source root for ${stateHash}`);
    return root;
  };
  return {
    workspaceId: "workspace:test",
    async ensureFresh() {
      return { stateHash: mainStateHash };
    },
    async unitHashes(stateHash, relPaths) {
      const root = rootForState(stateHash);
      return Object.fromEntries(
        relPaths.map((relPath) => {
          const dir = path.join(root, ...relPath.split("/"));
          return [relPath, fs.existsSync(dir) ? `h:${stateHash}:${relPath}` : null];
        })
      );
    },
    async resolveContextState(contextId) {
      return heads[`ctx:${contextId}`] ?? TEST_STATE;
    },
    async readFile() {
      return null;
    },
    executionStateForContent(stateHash) {
      return { kind: "event", eventId: `event:${stateHash}` };
    },
    async discoverGraph(stateHash) {
      return discoverPackageGraph(rootForState(stateHash));
    },
    onProtectedPublication() {
      return () => {};
    },
    async recordBuild() {},
    async materializeForBuild(_units, stateRef) {
      return { sourceRoot: rootForState(stateRef) };
    },
  };
}

describe("BuildSystemV2 library package subpaths", () => {
  let root: string;
  let workspaceRoot: string;
  let buildSystem: BuildSystemV2 | null;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-lib-subpath-"));
    workspaceRoot = path.join(root, "workspace");
    setUserDataPath(path.join(root, "state"));
    buildSystem = null;
  });

  afterEach(async () => {
    await buildSystem?.shutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("builds the requested package export subpath instead of the package root", async () => {
    const pkgDir = path.join(workspaceRoot, "packages", "split-library");
    fs.mkdirSync(path.join(pkgDir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({
        name: "@workspace/split-library",
        version: "0.1.0",
        type: "module",
        exports: {
          ".": "./src/root.ts",
          "./report": "./src/report.ts",
        },
      })
    );
    fs.writeFileSync(
      path.join(pkgDir, "src", "root.ts"),
      [
        'import { Buffer } from "node:buffer";',
        'export const root = await Promise.resolve(Buffer.from("root").toString("utf8"));',
        "",
      ].join("\n")
    );
    fs.writeFileSync(
      path.join(pkgDir, "src", "report.ts"),
      'export const marker = "safe-report-entry";\n'
    );
    buildSystem = await initBuildSystemV2(
      workspaceRoot,
      fakeWorkspaceSource(() => workspaceRoot),
      APP_NODE_MODULES,
      buildRoots(workspaceRoot)
    );

    const rootResult = await buildSystem.getBuild("@workspace/split-library", undefined, {
      library: true,
      libraryTarget: "panel",
    });
    expect(rootResult.format).toBe("async-cjs");
    expect(rootResult.bundle).toContain("await Promise.resolve");
    expect(rootResult.bundle).toContain("root");

    const result = await buildSystem.getBuild("@workspace/split-library/report", undefined, {
      library: true,
      libraryTarget: "panel",
    });
    expect(result.bundle).toContain("safe-report-entry");
    expect(result.format).toBe("async-cjs");
    expect(result.bundle).not.toContain("Buffer.from");
  });

  it("builds a requested package wildcard export subpath", async () => {
    const pkgDir = path.join(workspaceRoot, "skills", "test-suite");
    fs.mkdirSync(path.join(pkgDir, "tests"), { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({
        name: "@workspace-skills/test-suite",
        version: "0.1.0",
        type: "module",
        exports: {
          ".": "./index.ts",
          "./tests/*": "./tests/*.ts",
        },
      })
    );
    fs.writeFileSync(path.join(pkgDir, "index.ts"), 'export const root = "root-entry";\n');
    fs.writeFileSync(
      path.join(pkgDir, "tests", "workers.ts"),
      'export const marker = "wildcard-workers-entry";\n'
    );
    buildSystem = await initBuildSystemV2(
      workspaceRoot,
      fakeWorkspaceSource(() => workspaceRoot),
      APP_NODE_MODULES,
      buildRoots(workspaceRoot)
    );

    const result = await buildSystem.getBuild(
      "@workspace-skills/test-suite/tests/workers",
      undefined,
      { library: true, libraryTarget: "worker" }
    );
    expect(result.bundle).toContain("wildcard-workers-entry");
    expect(result.bundle).not.toContain("root-entry");
  });

  it("selects package export conditions by libraryTarget (panel vs eval/worker)", async () => {
    // A package with target-forked entries — exactly the shape that broke eval
    // imports: a panel entry that must NOT be picked for a DO host.
    const pkgDir = path.join(workspaceRoot, "packages", "dual-entry");
    fs.mkdirSync(path.join(pkgDir, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({
        name: "@workspace/dual-entry",
        version: "0.1.0",
        type: "module",
        exports: {
          ".": {
            "vibestudio-panel": "./src/panel.ts",
            worker: "./src/worker.ts",
            default: "./src/default.ts",
          },
        },
      })
    );
    fs.writeFileSync(
      path.join(pkgDir, "src", "panel.ts"),
      'export const marker = "PANEL-ENTRY";\n'
    );
    fs.writeFileSync(
      path.join(pkgDir, "src", "worker.ts"),
      'export const marker = "WORKER-ENTRY";\n'
    );
    fs.writeFileSync(
      path.join(pkgDir, "src", "default.ts"),
      'export const marker = "DEFAULT-ENTRY";\n'
    );
    buildSystem = await initBuildSystemV2(
      workspaceRoot,
      fakeWorkspaceSource(() => workspaceRoot),
      APP_NODE_MODULES,
      buildRoots(workspaceRoot)
    );

    // Panel target resolves the `vibestudio-panel` condition.
    const panelBuild = await buildSystem.getBuild("@workspace/dual-entry", undefined, {
      library: true,
      libraryTarget: "panel",
    });
    expect(panelBuild.bundle).toContain("PANEL-ENTRY");
    expect(panelBuild.bundle).not.toContain("WORKER-ENTRY");

    // Worker target (e.g. the workerd eval sandbox) resolves the `worker`
    // condition instead — and a distinct libraryTarget MUST yield a distinct
    // cache key, not the panel bundle.
    const workerBuild = await buildSystem.getBuild("@workspace/dual-entry", undefined, {
      library: true,
      libraryTarget: "worker",
    });
    expect(workerBuild.bundle).toContain("WORKER-ENTRY");
    expect(workerBuild.bundle).not.toContain("PANEL-ENTRY");
  });

  it("builds the real agentic runtime package with async transitive dependencies for eval", async () => {
    const actualWorkspaceRoot = exactUserlandRoot;
    buildSystem = await initBuildSystemV2(
      actualWorkspaceRoot,
      fakeWorkspaceSource(() => actualWorkspaceRoot),
      APP_NODE_MODULES,
      buildRoots(actualWorkspaceRoot)
    );

    const result = await buildSystem.getBuild("@workspace/agentic-do", undefined, {
      library: true,
      libraryTarget: "worker",
    });

    expect(result.format).toBe("async-cjs");
    expect(result.bundle).toContain("AgentWorkerBase");
    expect(result.bundle).not.toMatch(/require\(["']node:buffer["']\)/u);

    const module = { exports: {} as Record<string, unknown> };
    const dynamicDependencies: string[] = [];
    const wrappedBundle = `return (async () => {\n${result.bundle}\n})();`;
    new Script(`(function (require, exports, module) { ${wrappedBundle} })`, {
      filename: "agentic-do.eval-bundle.cjs",
    });
    const execute = new Function(
      "require",
      "exports",
      "module",
      "__vibestudioImport",
      wrappedBundle
    ) as (
      require: (specifier: string) => never,
      exports: Record<string, unknown>,
      module: { exports: Record<string, unknown> },
      dynamicImport: (specifier: string) => Promise<unknown>
    ) => Promise<void>;
    await execute(
      (specifier) => {
        if (specifier.startsWith("node:")) return requireNodeBuiltin(specifier) as never;
        throw new Error(`unexpected external dependency ${specifier}`);
      },
      module.exports,
      module,
      async (specifier) => {
        dynamicDependencies.push(specifier);
        return {};
      }
    );
    expect(Object.keys(module.exports)).toEqual(
      expect.arrayContaining(["AgentWorkerBase", "ChannelClient", "AgentLoopDriver"])
    );
    expect(dynamicDependencies).toEqual(
      expect.arrayContaining(["node:fs", "node:os", "node:path"])
    );
    // This deliberately builds the complete real agentic runtime graph. It takes
    // ~20s in isolation and competes with other build tests in the host suite, so
    // give this integration-sized assertion its own budget instead of weakening
    // the global unit-test timeout.
  }, 90_000);

  it("loads the real hosted runtime without ambient network authority", async () => {
    const actualWorkspaceRoot = exactUserlandRoot;
    buildSystem = await initBuildSystemV2(
      actualWorkspaceRoot,
      fakeWorkspaceSource(() => actualWorkspaceRoot),
      APP_NODE_MODULES,
      buildRoots(actualWorkspaceRoot)
    );

    const result = await buildSystem.getBuild("@workspace/runtime/hosted", undefined, {
      library: true,
      libraryTarget: "worker",
    });
    expect(result.format).toBe("async-cjs");

    const context = vm.createContext({});
    const realm = vm.runInContext("globalThis", context) as Record<string, unknown>;
    tameRealmCodegen(realm);
    const RealmFunction = getRealmCompiler(realm);
    // Node's vm realm omits web-platform text codecs that workerd provides.
    // Install guest-realm wrappers whose closures retain the host codecs but
    // whose functions, objects, and returned byte arrays all belong to the
    // tamed realm. Passing the host constructors or module endowments through
    // directly would reopen codegen through their constructor chains.
    const installTextCodecs = new RealmFunction(
      "HostTextDecoder",
      "HostTextEncoder",
      `
        globalThis.TextDecoder = class TextDecoder {
          #inner;
          constructor(...args) { this.#inner = new HostTextDecoder(...args); }
          decode(...args) { return this.#inner.decode(...args); }
          get encoding() { return this.#inner.encoding; }
          get fatal() { return this.#inner.fatal; }
          get ignoreBOM() { return this.#inner.ignoreBOM; }
        };
        globalThis.TextEncoder = class TextEncoder {
          #inner = new HostTextEncoder();
          encode(input) { return new Uint8Array(this.#inner.encode(input)); }
          encodeInto(input, destination) {
            const bytes = this.encode(input);
            const written = Math.min(bytes.byteLength, destination.byteLength);
            destination.set(bytes.subarray(0, written));
            return { read: input.length, written };
          }
          get encoding() { return this.#inner.encoding; }
        };
      `
    ) as (decoder: typeof TextDecoder, encoder: typeof TextEncoder) => void;
    installTextCodecs(TextDecoder, TextEncoder);
    const receiver = vm.runInContext(
      `(() => {
        const asyncHooks = {
          AsyncLocalStorage: class AsyncLocalStorage {
            getStore() { return undefined; }
            run(_store, callback) { return callback(); }
            exit(callback) { return callback(); }
            disable() {}
            enable() {}
            enterWith() {}
          },
        };
        const exports = Object.create(null);
        return [
          (specifier) => {
            if (specifier === "node:async_hooks") return asyncHooks;
            throw new Error("unexpected external dependency " + specifier);
          },
          exports,
          { exports },
          async (specifier) => { throw new Error("unexpected dynamic dependency " + specifier); }
        ];
      })()`,
      context
    ) as [
      (specifier: string) => never,
      Record<string, unknown>,
      { exports: Record<string, unknown> },
      (specifier: string) => Promise<never>,
    ];
    const module = receiver[2];
    const run = new RealmFunction(
      "scope",
      `with (scope) {
        return (function(require, exports, module, __vibestudioImport) {
          "use strict";
          return (async () => {
            ${result.bundle}
          })();
        }).apply(undefined, __vibestudioReceiver);
      }`
    ) as (scope: Record<PropertyKey, unknown>) => Promise<void>;

    const guestScope = createPrivateGuestGlobal(realm);
    guestScope["__vibestudioReceiver"] = receiver;
    await run(guestScope);
    expect(module.exports).toMatchObject({
      createHostedRuntime: expect.any(Function),
    });
  }, 30_000);

  it("resolves a build unit that exists only at a context ref", async () => {
    const mainRoot = path.join(root, "main-state");
    const contextRoot = path.join(root, "context-state");
    const pkgDir = path.join(contextRoot, "packages", "context-only");
    fs.mkdirSync(path.join(mainRoot, "packages"), { recursive: true });
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({
        name: "@workspace/context-only",
        version: "0.1.0",
        type: "module",
        exports: {
          ".": "./index.ts",
        },
      })
    );
    fs.writeFileSync(path.join(pkgDir, "index.ts"), 'export const marker = "ctx-only-unit";\n');

    buildSystem = await initBuildSystemV2(
      mainRoot,
      fakeMultiStateWorkspaceSource(
        {
          "state:main": mainRoot,
          [CONTEXT_STATE]: contextRoot,
        },
        "state:main",
        { "ctx:agent-1": CONTEXT_STATE }
      ),
      APP_NODE_MODULES,
      buildRoots(mainRoot)
    );

    await expect(
      buildSystem.getBuild("@workspace/context-only", undefined, {
        library: true,
        libraryTarget: "panel",
      })
    ).rejects.toMatchObject({
      code: "package_not_found",
      errorData: {
        code: "package_not_found",
        specifier: "@workspace/context-only",
        ref: "main",
      },
    });

    const result = await buildSystem.getBuild("@workspace/context-only", "ctx:agent-1", {
      library: true,
      libraryTarget: "panel",
    });
    expect(result.bundle).toContain("ctx-only-unit");
  });

  it("resolves context-only units without building them", async () => {
    const mainRoot = path.join(root, "main-resolve-state");
    const contextRoot = path.join(root, "context-resolve-state");
    const panelDir = path.join(contextRoot, "panels", "context-panel");
    fs.mkdirSync(path.join(mainRoot, "panels"), { recursive: true });
    fs.mkdirSync(panelDir, { recursive: true });
    fs.writeFileSync(
      path.join(panelDir, "package.json"),
      JSON.stringify({
        name: "@workspace-panels/context-panel",
        version: "0.1.0",
        type: "module",
        vibestudio: { entry: "index.tsx" },
        dependencies: {},
      })
    );
    fs.writeFileSync(
      path.join(panelDir, "index.tsx"),
      "export default function App() { return null; }\n"
    );

    buildSystem = await initBuildSystemV2(
      mainRoot,
      fakeMultiStateWorkspaceSource(
        {
          "state:main-resolve": mainRoot,
          [RESOLVE_CONTEXT_STATE]: contextRoot,
        },
        "state:main-resolve",
        { "ctx:agent-resolve": RESOLVE_CONTEXT_STATE }
      ),
      APP_NODE_MODULES,
      buildRoots(mainRoot)
    );

    await expect(buildSystem.resolveBuildUnit("panels/context-panel")).resolves.toBeNull();
    await expect(
      buildSystem.resolveBuildUnit("panels/context-panel", "ctx:agent-resolve")
    ).resolves.toMatchObject({
      unitPath: "panels/context-panel",
      unitName: "@workspace-panels/context-panel",
      kind: "panel",
      stateHash: RESOLVE_CONTEXT_STATE,
    });
  });

  it("builds a declared sandbox test suite as an exact immutable artifact", async () => {
    const workspaceRuntimeDir = path.join(workspaceRoot, "packages", "runtime");
    const runtimeDir = path.join(workspaceRoot, "packages", "test-runtime");
    const panelDir = path.join(workspaceRoot, "panels", "counter");
    fs.mkdirSync(path.join(workspaceRuntimeDir, "src"), { recursive: true });
    fs.mkdirSync(path.join(runtimeDir, "src"), { recursive: true });
    fs.mkdirSync(panelDir, { recursive: true });
    fs.writeFileSync(
      path.join(workspaceRuntimeDir, "package.json"),
      JSON.stringify({
        name: "@workspace/runtime",
        type: "module",
        exports: { ".": "./src/index.ts" },
      })
    );
    fs.writeFileSync(
      path.join(workspaceRuntimeDir, "src", "index.ts"),
      "export const rpc = { expose: () => {} };\n"
    );
    fs.writeFileSync(
      path.join(runtimeDir, "src", "index.ts"),
      "export const setCurrentTestFile = (_file: string) => {}; export const test = (_name: string, _fn: () => void) => {}; export const runTests = () => ({ ok: true });\n"
    );
    fs.writeFileSync(
      path.join(runtimeDir, "package.json"),
      JSON.stringify({
        name: "@workspace/test-runtime",
        type: "module",
        exports: { ".": "./src/index.ts" },
      })
    );
    fs.writeFileSync(
      path.join(panelDir, "package.json"),
      JSON.stringify({
        name: "@workspace-panels/counter",
        type: "module",
        vibestudio: {
          entry: "index.tsx",
          tests: [{ name: "unit", runtime: "browser", include: ["**/*.test.ts"] }],
        },
        dependencies: {
          "@workspace/runtime": "workspace:*",
          "@workspace/test-runtime": "workspace:*",
        },
      })
    );
    fs.writeFileSync(path.join(panelDir, "index.tsx"), "export default null;\n");
    fs.writeFileSync(
      path.join(panelDir, "counter.test.ts"),
      'import { test } from "@workspace/test-runtime"; test("counter", () => {});\n'
    );
    buildSystem = await initBuildSystemV2(
      workspaceRoot,
      fakeWorkspaceSource(() => workspaceRoot),
      APP_NODE_MODULES,
      buildRoots(workspaceRoot)
    );

    const artifact = await buildSystem.getTestArtifact("panels/counter", `state:${"a".repeat(64)}`);
    expect(artifact).toMatchObject({
      protocol: "workspace-test-artifact.v1",
      target: "panels/counter",
      suite: "unit",
      runtime: "browser",
      selectedFiles: ["counter.test.ts"],
    });
    expect(artifact.execution.executionDigest).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("builds workerd suites with the same Node compatibility as their worker runtime", async () => {
    const workspaceRuntimeDir = path.join(workspaceRoot, "packages", "runtime");
    const runtimeDir = path.join(workspaceRoot, "packages", "test-runtime");
    const workerDir = path.join(workspaceRoot, "workers", "portable");
    fs.mkdirSync(path.join(workspaceRuntimeDir, "src"), { recursive: true });
    fs.mkdirSync(path.join(runtimeDir, "src"), { recursive: true });
    fs.mkdirSync(workerDir, { recursive: true });
    fs.writeFileSync(
      path.join(workspaceRuntimeDir, "package.json"),
      JSON.stringify({
        name: "@workspace/runtime",
        type: "module",
        exports: { "./worker": "./src/worker.ts" },
      })
    );
    fs.writeFileSync(
      path.join(workspaceRuntimeDir, "src", "worker.ts"),
      "export const createWorkerRuntime = () => ({ rpc: { expose: () => {} } }); export const handleWorkerRpc = () => null;\n"
    );
    fs.writeFileSync(
      path.join(runtimeDir, "package.json"),
      JSON.stringify({
        name: "@workspace/test-runtime",
        type: "module",
        exports: { ".": "./src/index.ts" },
      })
    );
    fs.writeFileSync(
      path.join(runtimeDir, "src", "index.ts"),
      "export const setCurrentTestFile = () => {}; export const test = (_name: string, _fn: () => void) => {}; export const runTests = () => ({});\n"
    );
    fs.writeFileSync(
      path.join(workerDir, "package.json"),
      JSON.stringify({
        name: "@workspace-workers/portable",
        type: "module",
        vibestudio: {
          entry: "index.ts",
          tests: [{ name: "unit", runtime: "workerd", include: ["**/*.test.ts"] }],
        },
        dependencies: {
          "@workspace/runtime": "workspace:*",
          "@workspace/test-runtime": "workspace:*",
        },
      })
    );
    fs.writeFileSync(path.join(workerDir, "index.ts"), "export default {};\n");
    fs.writeFileSync(
      path.join(workerDir, "portable.test.ts"),
      'import { AsyncLocalStorage } from "node:async_hooks"; import { test } from "@workspace/test-runtime"; test("context", () => { new AsyncLocalStorage(); });\n'
    );
    buildSystem = await initBuildSystemV2(
      workspaceRoot,
      fakeWorkspaceSource(() => workspaceRoot),
      APP_NODE_MODULES,
      buildRoots(workspaceRoot)
    );

    const artifact = await buildSystem.getTestArtifact(
      "workers/portable",
      `state:${"a".repeat(64)}`
    );
    expect(artifact).toMatchObject({
      target: "workers/portable",
      suite: "unit",
      runtime: "workerd",
      selectedFiles: ["portable.test.ts"],
    });
    expect(artifact.execution.executionDigest).toMatch(/^[0-9a-f]{64}$/u);
  });

  it("builds browser suites with the same fs and path shims as their panel runtime", async () => {
    const workspaceRuntimeDir = path.join(workspaceRoot, "packages", "runtime");
    const runtimeDir = path.join(workspaceRoot, "packages", "test-runtime");
    const panelDir = path.join(workspaceRoot, "panels", "portable");
    fs.mkdirSync(path.join(workspaceRuntimeDir, "src"), { recursive: true });
    fs.mkdirSync(path.join(runtimeDir, "src"), { recursive: true });
    fs.mkdirSync(panelDir, { recursive: true });
    fs.writeFileSync(
      path.join(workspaceRuntimeDir, "package.json"),
      JSON.stringify({
        name: "@workspace/runtime",
        type: "module",
        exports: { ".": "./src/index.ts" },
      })
    );
    fs.writeFileSync(
      path.join(workspaceRuntimeDir, "src", "index.ts"),
      "export const rpc = { expose: () => {} }; export const fs = {};\n"
    );
    fs.writeFileSync(
      path.join(runtimeDir, "package.json"),
      JSON.stringify({
        name: "@workspace/test-runtime",
        type: "module",
        exports: { ".": "./src/index.ts" },
      })
    );
    fs.writeFileSync(
      path.join(runtimeDir, "src", "index.ts"),
      "export const setCurrentTestFile = () => {}; export const test = (_name: string, _fn: () => void) => {}; export const runTests = () => ({});\n"
    );
    fs.writeFileSync(
      path.join(panelDir, "package.json"),
      JSON.stringify({
        name: "@workspace-panels/portable",
        type: "module",
        vibestudio: {
          entry: "index.tsx",
          tests: [{ name: "unit", runtime: "browser", include: ["**/*.test.ts"] }],
        },
        dependencies: {
          "@workspace/runtime": "workspace:*",
          "@workspace/test-runtime": "workspace:*",
        },
      })
    );
    fs.writeFileSync(path.join(panelDir, "index.tsx"), "export default null;\n");
    fs.writeFileSync(
      path.join(panelDir, "portable.test.ts"),
      'import fs from "fs"; import path from "path"; import { test } from "@workspace/test-runtime"; test("runtime shims", () => { void fs; void path; });\n'
    );
    buildSystem = await initBuildSystemV2(
      workspaceRoot,
      fakeWorkspaceSource(() => workspaceRoot),
      APP_NODE_MODULES,
      buildRoots(workspaceRoot)
    );

    const artifact = await buildSystem.getTestArtifact(
      "panels/portable",
      `state:${"a".repeat(64)}`
    );
    expect(artifact).toMatchObject({
      target: "panels/portable",
      suite: "unit",
      runtime: "browser",
      selectedFiles: ["portable.test.ts"],
    });
  });
});

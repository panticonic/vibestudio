import { runIsolatedBuildJob } from "./nativeJobTestFixture.js";
/**
 * End-to-end build coverage for the framework-agnostic panel pipeline: it drives
 * a real `buildUnit()` through `resolveTemplate` → `getAdapter` → the vanilla /
 * svelte adapters → esbuild, and asserts the resolved framework plus
 * framework-appropriate bundle markers.
 *
 * Modeled on builder.terminalWorker.test.ts (temp workspace, working-tree source
 * provider, `initBuilder([repo/node_modules])`).
 *
 * REDUCTION (intentional, per task brief): rather than copying the *real*
 * `workspace/panels/hello-vanilla` / `hello-svelte` example panels and their
 * heavy transitive workspace graph (`@workspace/runtime` alone pulls in ~10
 * workspace packages + npm deps), this test builds equivalent MINIMAL INLINE
 * fixtures in the temp workspace. They are named `hello-vanilla` / `hello-svelte`
 * and exercise the exact same adapter code paths the real panels do:
 *   - vanilla: own index.html + only `@workspace/runtime` ⇒ vanilla framework,
 *     entry wrapper with NO mount helper, bundle free of any framework runtime.
 *   - svelte: `template: "svelte"` + `@workspace/svelte` ⇒ svelte framework, a
 *     compiled `.svelte` component, and the Svelte 5 `mount()` auto-mount path.
 *
 * What was reduced and why:
 *   - `@workspace/runtime` is a tiny stub (no transitive deps) so the build is
 *     fast/hermetic; the resolve plugin + bundling are still exercised.
 *   - `@workspace/svelte` is a tiny stub whose `autoMountSveltePanel` uses
 *     Svelte 5 `mount()` from "svelte" (the behavior the real package targets).
 *   - `svelte` is intentionally NOT declared as a panel dependency: that keeps
 *     `ensureExternalDeps` from running a real `npm install`. The svelte compiler
 *     (esbuild-svelte) and runtime resolve from the repo's node_modules via the
 *     nodePaths passed to `initBuilder`, so the svelte compile path is fully real.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setUserDataPath } from "@vibestudio/env-paths";

import { buildUnit, initBuilder } from "./builder.js";
import { BuildDiagnosticsError, diagnosticsFromError } from "./diagnostics.js";
import { setBuildRootConfig } from "./effectiveVersion.js";
import { setBuildSourceProvider, workingTreeSourceProvider } from "./buildSource.js";
import { setBuildExecutionIdentityContext } from "./buildStore.js";
beforeAll(() => setBuildSourceProvider(workingTreeSourceProvider()));
afterAll(() => setBuildSourceProvider(null));
import { discoverPackageGraph } from "./packageGraph.js";

const REPO_ROOT = process.cwd();
const SOURCE_STATE_HASH = `state:${"c".repeat(64)}`;

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
}
function commit(dir: string, msg: string): void {
  git(dir, ["init", "-b", "main"]);
  git(dir, ["add", "."]);
  git(dir, [
    "-c",
    "user.name=Vibestudio Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-m",
    msg,
  ]);
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

describe("buildUnit framework-agnostic panel builds", () => {
  let root: string;
  let workspaceRoot: string;

  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-frameworks-build-"));
    workspaceRoot = path.join(root, "workspace");
    await setBuildRootConfig({ appRoot: REPO_ROOT, workspaceRoot });
    setUserDataPath(path.join(root, "state"));
    setBuildExecutionIdentityContext({
      serviceAuthorityForSource: async () =>
        "b7e01c5f5a5351d9b1e459b5fc9e3c36920637eac75afd9ad271b3a0d8736e06",
      workspaceId: "workspace:test",
      executionStateForContent: (stateHash) => ({ kind: "event", eventId: `event:${stateHash}` }),
    });
    // Resolve esbuild-svelte / svelte (and any other npm deps) from the repo's
    // real node_modules instead of a fresh install.
    initBuilder([path.join(REPO_ROOT, "node_modules")], REPO_ROOT, runIsolatedBuildJob);
  });

  afterEach(async () => {
    await setBuildRootConfig(null);
    fs.rmSync(root, { recursive: true, force: true });
  });

  /**
   * Shared stub workspace packages + the svelte template. Kept deliberately
   * minimal — see the file header for the reduction rationale.
   */
  function scaffoldStubPackages(): void {
    // Stub @workspace/runtime — no transitive deps.
    const runtimeDir = path.join(workspaceRoot, "packages", "runtime");
    writeJson(path.join(runtimeDir, "package.json"), {
      name: "@workspace/runtime",
      version: "0.1.0",
      private: true,
      type: "module",
      exports: { ".": "./index.ts" },
    });
    fs.writeFileSync(
      path.join(runtimeDir, "index.ts"),
      'export const id = "stub-runtime";\nexport function greet(name) { return "hello " + name; }\n'
    );
    commit(runtimeDir, "runtime");

    // Stub @workspace/svelte — Svelte 5 mount()-based auto-mount (the API the
    // svelte adapter's generated entry imports). Deliberately does NOT declare a
    // `svelte` dependency so no npm install happens; `mount` resolves from the
    // repo node_modules via the builder's nodePaths.
    const svelteDir = path.join(workspaceRoot, "packages", "svelte");
    writeJson(path.join(svelteDir, "package.json"), {
      name: "@workspace/svelte",
      version: "0.1.0",
      private: true,
      type: "module",
      exports: { ".": "./index.ts" },
    });
    fs.writeFileSync(
      path.join(svelteDir, "index.ts"),
      [
        'import { mount } from "svelte";',
        "export function shouldAutoMount(m) {",
        "  if (m && m.__noAutoMount === true) return false;",
        "  return !!(m && (m.default || m.App));",
        "}",
        "export function autoMountSveltePanel(m) {",
        "  const Component = m && (m.default ?? m.App);",
        '  const target = document.getElementById("root");',
        "  if (target && Component) mount(Component, { target });",
        "}",
        "",
      ].join("\n")
    );
    commit(svelteDir, "svelte");

    // Svelte template (html shell + framework declaration), referenced by the
    // svelte panel via `vibestudio.template: "svelte"`.
    const tmplDir = path.join(workspaceRoot, "templates", "svelte");
    writeJson(path.join(tmplDir, "template.json"), { framework: "svelte" });
    fs.writeFileSync(
      path.join(tmplDir, "index.html"),
      '<!doctype html><html><head><title>Svelte</title></head><body><div id="root"></div><script src="bundle.js"></script></body></html>'
    );
    commit(tmplDir, "svelte template");
  }

  it.each([
    { subpath: ".", target: null, error: /not exported for runtime conditions/ },
    { subpath: "./fixture", target: null, error: /not exported for runtime conditions/ },
    { subpath: ".", target: "./missing.ts", error: /resolves to a missing file/ },
  ])(
    "enforces the declared export for $subpath without a main/source fallback",
    async ({ subpath, target, error }) => {
      scaffoldStubPackages();
      const libraryDir = path.join(workspaceRoot, "packages", "restricted");
      writeJson(path.join(libraryDir, "package.json"), {
        name: "@workspace/restricted",
        version: "0.1.0",
        type: "module",
        main: "./index.ts",
        exports: { [subpath]: { "vibestudio-panel": target, default: "./index.ts" } },
      });
      fs.writeFileSync(path.join(libraryDir, "index.ts"), "export const value = 'forbidden';\n");
      commit(libraryDir, "restricted runtime export");
      const panelDir = path.join(workspaceRoot, "panels", "restricted-import");
      writeJson(path.join(panelDir, "package.json"), {
        name: "@workspace-panels/restricted-import",
        version: "0.1.0",
        type: "module",
        vibestudio: { entry: "index.ts" },
        dependencies: {
          "@workspace/runtime": "workspace:*",
          "@workspace/restricted": "workspace:*",
        },
      });
      const specifier = subpath === "." ? "@workspace/restricted" : "@workspace/restricted/fixture";
      fs.writeFileSync(
        path.join(panelDir, "index.ts"),
        `import { value } from "${specifier}"; document.body.textContent = value;\n`
      );
      fs.writeFileSync(
        path.join(panelDir, "index.html"),
        '<html><body><div id="root"></div></body></html>'
      );
      commit(panelDir, "restricted import");
      const graph = discoverPackageGraph(workspaceRoot);
      await expect(
        buildUnit(
          graph.get("@workspace-panels/restricted-import"),
          "e".repeat(64),
          graph,
          workspaceRoot,
          SOURCE_STATE_HASH
        )
      ).rejects.toThrow(error);
    }
  );

  it("returns editable source coordinates after a native compiler failure", async () => {
    scaffoldStubPackages();
    const panelDir = path.join(workspaceRoot, "panels", "broken");
    writeJson(path.join(panelDir, "package.json"), {
      name: "@workspace-panels/broken",
      version: "0.1.0",
      type: "module",
      vibestudio: { title: "Broken", entry: "index.ts" },
      dependencies: { "@workspace/runtime": "workspace:*" },
    });
    fs.writeFileSync(
      path.join(panelDir, "index.html"),
      '<html><body><div id="root"></div></body></html>'
    );
    fs.writeFileSync(path.join(panelDir, "index.ts"), "const broken = );\n");
    commit(panelDir, "broken source");
    const graph = discoverPackageGraph(workspaceRoot);
    const failure = await buildUnit(
      graph.get("@workspace-panels/broken"),
      "d".repeat(64),
      graph,
      workspaceRoot,
      SOURCE_STATE_HASH
    ).then(
      () => {
        throw new Error("Invalid source unexpectedly compiled");
      },
      (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(BuildDiagnosticsError);
    expect(
      diagnosticsFromError(failure, {
        workspaceRoot,
        sourceRoot: workspaceRoot,
        unitRelativePath: "panels/broken",
      })
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "esbuild", file: "panels/broken/index.ts", line: 1 }),
      ])
    );
  });

  it("reports malformed authority at the manifest rather than as an anonymous bundler failure", async () => {
    scaffoldStubPackages();
    const panelDir = path.join(workspaceRoot, "panels", "broken-authority");
    writeJson(path.join(panelDir, "package.json"), {
      name: "@workspace-panels/broken-authority",
      version: "0.1.0",
      type: "module",
      vibestudio: {
        entry: "index.ts",
        authority: { requests: [], provides: [], serviceRequests: ["notes.v1"] },
      },
    });
    fs.writeFileSync(path.join(panelDir, "index.ts"), "export {};\n");
    commit(panelDir, "malformed authority");
    const graph = discoverPackageGraph(workspaceRoot);
    let caught: unknown;
    try {
      await buildUnit(
        graph.get("@workspace-panels/broken-authority"),
        "f".repeat(64),
        graph,
        workspaceRoot,
        SOURCE_STATE_HASH
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BuildDiagnosticsError);
    expect((caught as BuildDiagnosticsError).diagnostics).toEqual([
      expect.objectContaining({
        source: "authority",
        file: "panels/broken-authority/package.json",
        line: 1,
        column: 1,
        message: expect.stringContaining("protocol and availability"),
      }),
    ]);
    expect(
      diagnosticsFromError(caught, {
        workspaceRoot,
        sourceRoot: workspaceRoot,
        unitRelativePath: "panels/broken-authority",
      })
    ).toEqual((caught as BuildDiagnosticsError).diagnostics);
  });

  it("builds a vanilla panel: framework=vanilla, no framework runtime, no mount helper", async () => {
    scaffoldStubPackages();

    // Own index.html ⇒ self-contained; only @workspace/runtime ⇒ vanilla framework.
    const panelDir = path.join(workspaceRoot, "panels", "hello-vanilla");
    writeJson(path.join(panelDir, "package.json"), {
      name: "@workspace-panels/hello-vanilla",
      version: "0.1.0",
      private: true,
      type: "module",
      vibestudio: { title: "Hello Vanilla", entry: "index.ts" },
      dependencies: { "@workspace/runtime": "workspace:*" },
    });
    fs.writeFileSync(
      path.join(panelDir, "index.ts"),
      [
        'import { greet } from "@workspace/runtime";',
        'const el = document.getElementById("root");',
        'if (el) el.textContent = greet("vanilla");',
        "",
      ].join("\n")
    );
    fs.writeFileSync(
      path.join(panelDir, "index.html"),
      '<!doctype html><html><head><title>Vanilla</title></head><body><div id="root"></div><script src="bundle.js"></script></body></html>'
    );
    commit(panelDir, "hello-vanilla");

    const graph = discoverPackageGraph(workspaceRoot);
    const result = await buildUnit(
      graph.get("@workspace-panels/hello-vanilla"),
      "a".repeat(64),
      graph,
      workspaceRoot,
      SOURCE_STATE_HASH
    );

    expect(result.metadata.framework).toBe("vanilla");

    const bundle = result.artifacts.find((a) => a.role === "primary")?.content ?? "";
    expect(bundle.length).toBeGreaterThan(0);
    // The workspace dependency was resolved + bundled from source.
    expect(bundle).toContain("hello ");
    // Vanilla pulls in NO framework runtime: no React, no svelte auto-mount.
    expect(bundle).not.toMatch(/react/i);
    expect(bundle).not.toMatch(/autoMount/i);
    expect(bundle).not.toContain("@radix-ui");
    // Without a framework runtime the bundle stays tiny (sanity bound).
    expect(bundle.length).toBeLessThan(50_000);

    // Self-contained: the panel's OWN html shell is used, with the title injected.
    const html = result.artifacts.find((a) => a.role === "html")?.content ?? "";
    expect(html).toContain('id="root"');
    expect(html).toContain("<title>Hello Vanilla</title>");
  }, 60_000);

  it("builds a svelte panel: framework=svelte, compiled component + Svelte 5 mount() (no new Component)", async () => {
    scaffoldStubPackages();

    const panelDir = path.join(workspaceRoot, "panels", "hello-svelte");
    writeJson(path.join(panelDir, "package.json"), {
      name: "@workspace-panels/hello-svelte",
      version: "0.1.0",
      private: true,
      type: "module",
      vibestudio: { title: "Hello Svelte", entry: "index.ts", template: "svelte" },
      dependencies: { "@workspace/runtime": "workspace:*", "@workspace/svelte": "workspace:*" },
    });
    // Entry re-exports the component as default; the svelte adapter's generated
    // wrapper auto-mounts it.
    fs.writeFileSync(path.join(panelDir, "index.ts"), 'export { default } from "./App.svelte";\n');
    fs.writeFileSync(
      path.join(panelDir, "App.svelte"),
      '<script>\n  let name = "svelte";\n</script>\n\n<div class="hello">Hello {name}</div>\n'
    );
    commit(panelDir, "hello-svelte");

    const graph = discoverPackageGraph(workspaceRoot);
    const result = await buildUnit(
      graph.get("@workspace-panels/hello-svelte"),
      "b".repeat(64),
      graph,
      workspaceRoot,
      SOURCE_STATE_HASH
    );

    expect(result.metadata.framework).toBe("svelte");

    const bundle = result.artifacts.find((a) => a.role === "primary")?.content ?? "";
    expect(bundle.length).toBeGreaterThan(0);

    // Svelte 5 runtime artifacts are bundled (the svelte adapter's
    // esbuild-svelte plugin compiled the component). Production panel builds
    // minify private runtime helper names, so behavior-bearing markup is the
    // stable assertion here.
    expect(bundle).toContain("__svelte");

    // The .svelte component was actually compiled into the bundle (its static
    // markup appears as a template string), not merely referenced.
    expect(bundle).toContain('class="hello"');

    // The adapter must not regress to the legacy Svelte 4 constructor API.
    expect(bundle).not.toMatch(/new\s+Component\d*\s*\(/);

    // The svelte TEMPLATE html shell was selected (not the panel's own / default),
    // with the panel title injected.
    const html = result.artifacts.find((a) => a.role === "html")?.content ?? "";
    expect(html).toContain('id="root"');
    expect(html).toContain("<title>Hello Svelte</title>");
  }, 60_000);

  it("builds the manifest-declared website entry as self-contained browser artifacts", async () => {
    scaffoldStubPackages();
    const panelDir = path.join(workspaceRoot, "panels", "portable-site");
    writeJson(path.join(panelDir, "package.json"), {
      name: "@workspace-panels/portable-site",
      version: "0.1.0",
      private: true,
      type: "module",
      vibestudio: {
        title: "Portable Site",
        entry: "panel.ts",
        website: {
          entry: "site.ts",
          title: "Public Portable Site",
          expects: "A workspace with useful tools",
          suggestedTemplates: [
            { label: "Starter", locator: { url: "https://example.test/template" } },
          ],
        },
      },
    });
    fs.writeFileSync(path.join(panelDir, "panel.ts"), "export default function Panel() {}\n");
    fs.writeFileSync(
      path.join(panelDir, "site.ts"),
      'document.getElementById("root")!.textContent = "portable website";\n'
    );
    commit(panelDir, "portable site");

    const graph = discoverPackageGraph(workspaceRoot);
    const result = await buildUnit(
      graph.get("@workspace-panels/portable-site"),
      "d".repeat(64),
      graph,
      workspaceRoot,
      SOURCE_STATE_HASH,
      { website: true }
    );

    expect(result.metadata.details).toEqual({
      kind: "website-bundle",
      entryArtifact: expect.stringMatching(/site.*\.js$/),
      declaration: expect.objectContaining({
        entry: "site.ts",
        expects: "A workspace with useful tools",
      }),
    });
    expect(result.artifacts.every((artifact) => artifact.role !== "html")).toBe(true);
    expect(result.artifacts.find((artifact) => artifact.role === "primary")?.content).toContain(
      "portable website"
    );
  }, 60_000);
});

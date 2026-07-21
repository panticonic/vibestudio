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
import { setBuildSourceProvider, workingTreeSourceProvider } from "./buildSource.js";
beforeAll(() => setBuildSourceProvider(workingTreeSourceProvider()));
afterAll(() => setBuildSourceProvider(null));
import { discoverPackageGraph } from "./packageGraph.js";

const REPO_ROOT = process.cwd();

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

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-frameworks-build-"));
    workspaceRoot = path.join(root, "workspace");
    setUserDataPath(path.join(root, "state"));
    // Resolve esbuild-svelte / svelte (and any other npm deps) from the repo's
    // real node_modules instead of a fresh install.
    initBuilder([path.join(REPO_ROOT, "node_modules")]);
  });

  afterEach(() => {
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
      "state:test"
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
      "state:test"
    );

    expect(result.metadata.framework).toBe("svelte");

    const bundle = result.artifacts.find((a) => a.role === "primary")?.content ?? "";
    expect(bundle.length).toBeGreaterThan(0);

    // Svelte 5 runtime artifacts are bundled (the svelte adapter's esbuild-svelte
    // plugin compiled the component + pulled in svelte/internal/client and the
    // version-disclosure module).
    expect(bundle).toContain("__svelte");
    expect(bundle).toContain("from_html"); // Svelte 5 client template helper
    expect(bundle).toContain("PUBLIC_VERSION");

    // The .svelte component was actually compiled into the bundle (its static
    // markup appears as a template string), not merely referenced.
    expect(bundle).toContain('class="hello"');

    // The component is mounted via the Svelte 5 `mount()` API...
    expect(bundle).toMatch(/\bmount\d*\s*\(/);
    // ...and NOT instantiated with the legacy Svelte 4 `new Component(...)` API.
    expect(bundle).not.toMatch(/new\s+Component\d*\s*\(/);

    // The svelte TEMPLATE html shell was selected (not the panel's own / default),
    // with the panel title injected.
    const html = result.artifacts.find((a) => a.role === "html")?.content ?? "";
    expect(html).toContain('id="root"');
    expect(html).toContain("<title>Hello Svelte</title>");
  }, 60_000);
});

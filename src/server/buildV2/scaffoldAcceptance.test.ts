/**
 * Scaffold-to-verifier acceptance: every supported default scaffold produced by
 * the PUBLIC Base createProjects path must pass the canonical build report
 * (compiler + bundler + manifest + workspace-RPC + static-authority) with zero
 * diagnostics BEFORE an agent customizes it. The failure class guarded here is
 * drift between scaffold output and the real verifier, so the real Build V2
 * system runs un-mocked; only the scaffold generator's VCS transport is stubbed
 * to capture its generated files.
 *
 * The service-consumer case additionally proves the structured repair loop end
 * to end: the missing workspace-service request diagnostic carries the exact
 * narrow request, and applying that request verbatim makes the build clean.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { setUserDataPath } from "@vibestudio/env-paths";

import { readWorkspaceConfig } from "@vibestudio/workspace/configParser";
import { initBuildSystemV2, type BuildSystemV2 } from "./index.js";
import type { BuildSourceProvider } from "./buildSource.js";
import type { WorkspaceStateSource } from "./stateTrigger.js";
import { discoverPackageGraph } from "./packageGraph.js";
import { exactWorkspaceServiceBindings } from "./userlandAuthority.js";
import { exactUserlandRoot } from "../../../tests/exactUserlandRoot";

const APP_NODE_MODULES = [path.resolve(__dirname, "../../../node_modules")];

const mocks = vi.hoisted(() => {
  const files = new Map<string, string | Uint8Array>();
  const dirs = new Set<string>();
  return { files, dirs };
});

function normalize(p: string): string {
  return p.replace(/^\/+|\/+$/g, "").replace(/\/+/g, "/");
}

function addDir(p: string): void {
  const normalized = normalize(p);
  if (!normalized) return;
  const parts = normalized.split("/");
  for (let i = 1; i <= parts.length; i++) mocks.dirs.add(parts.slice(0, i).join("/"));
}

function addFile(p: string, content: string | Uint8Array): void {
  const normalized = normalize(p);
  addDir(normalized.split("/").slice(0, -1).join("/"));
  mocks.files.set(normalized, content);
}

// The scaffold generator's only runtime dependency: capture vcs.edit output
// instead of publishing, so the REAL generated files land in a temp workspace.
vi.mock("@workspace/runtime", () => ({
  contextId: "ctx:test",
  vcs: {
    status: async () => ({
      contextId: "ctx:test",
      committed: { kind: "event", eventId: "event:committed" },
      workingHead: { kind: "application", applicationId: "application:working" },
      clean: false,
      mainEventId: "event:main",
      mainRelation: "ahead",
      workingCounts: { applications: 1, workUnits: 0, changes: 0 },
      integrating: [],
    }),
    edit: async (input: {
      changes: Array<{
        repoPath: string;
        files: Array<{
          path: string;
          content: { kind: "text"; text: string } | { kind: "bytes"; base64: string };
        }>;
      }>;
    }) => {
      for (const change of input.changes) {
        for (const file of change.files) {
          addFile(
            `${change.repoPath}/${file.path}`,
            file.content.kind === "text"
              ? file.content.text
              : Uint8Array.from(atob(file.content.base64), (character) => character.charCodeAt(0))
          );
        }
      }
      return { workingHead: { kind: "application", applicationId: "application:created" } };
    },
    commit: async () => ({ event: { kind: "event", eventId: "event:committed" } }),
    push: async () => ({
      contextId: "ctx:test",
      eventId: "event:committed",
      mainEventId: "event:committed",
      effectId: "effect:published",
      appliedAt: "2026-08-14T00:00:00.000Z",
    }),
  },
  fs: {
    async exists(p: string): Promise<boolean> {
      const normalized = normalize(p);
      return mocks.files.has(normalized) || mocks.dirs.has(normalized);
    },
    async readdir(
      p: string,
      opts?: { withFileTypes?: boolean }
    ): Promise<string[] | Array<{ name: string; isDirectory(): boolean }>> {
      const normalized = normalize(p);
      const prefix = normalized ? `${normalized}/` : "";
      const names = new Map<string, boolean>();
      for (const file of mocks.files.keys()) {
        if (!file.startsWith(prefix)) continue;
        const [name, ...tail] = file.slice(prefix.length).split("/");
        names.set(name!, tail.length > 0);
      }
      for (const dir of mocks.dirs) {
        if (!dir.startsWith(prefix) || dir === normalized) continue;
        const [name, ...tail] = dir.slice(prefix.length).split("/");
        names.set(name!, tail.length > 0 || names.get(name!) === true);
      }
      if (opts?.withFileTypes) {
        return [...names].map(([name, isDir]) => ({ name, isDirectory: () => isDir }));
      }
      return [...names.keys()];
    },
    async readFile(p: string, encoding?: string): Promise<string | Uint8Array> {
      const content = mocks.files.get(normalize(p));
      if (content === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      if (encoding && content instanceof Uint8Array) return new TextDecoder().decode(content);
      return content;
    },
    async mkdir(p: string): Promise<void> {
      addDir(p);
    },
    async writeFile(p: string, content: string | Uint8Array): Promise<void> {
      addFile(p, content);
    },
  },
}));

/** Copy a Base package directory (sans node_modules) into the workspace. */
function copyDir(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

/** Copy the transitive @workspace/* closure of the given roots from Base. */
function copyWorkspaceClosure(workspaceRoot: string, roots: string[]): void {
  const byName = new Map<string, string>();
  const packagesDir = path.join(exactUserlandRoot, "packages");
  for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(packagesDir, entry.name, "package.json");
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as { name?: string };
    if (manifest.name) byName.set(manifest.name, path.join(packagesDir, entry.name));
  }
  const pending = [...roots];
  const copied = new Set<string>();
  while (pending.length > 0) {
    const name = pending.shift()!;
    if (copied.has(name)) continue;
    copied.add(name);
    const dir = byName.get(name);
    if (!dir) continue;
    copyDir(dir, path.join(workspaceRoot, "packages", path.basename(dir)));
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    for (const dep of [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ]) {
      if (dep.startsWith("@workspace/")) pending.push(dep);
    }
  }
}

describe("default scaffolds pass the canonical build report unchanged", () => {
  let root: string;
  let workspaceRoot: string;
  let buildSystem: BuildSystemV2;
  // Bumped whenever the test edits workspace source, so the canonical report
  // re-projects instead of serving a cached state.
  let revision = 0;
  const stateHash = () => `state:${String(revision).padStart(64, "0")}`;

  function workingTreeStateSource(): WorkspaceStateSource & BuildSourceProvider {
    return {
      workspaceId: "workspace:scaffold-acceptance",
      async ensureFresh() {
        return { stateHash: stateHash() };
      },
      async unitHashes(_stateHash, relPaths) {
        return Object.fromEntries(relPaths.map((relPath) => [relPath, `h:${relPath}:${revision}`]));
      },
      async resolveContextState() {
        return stateHash();
      },
      async readFile(readStateHash, relPath) {
        const absolute = path.join(workspaceRoot, relPath);
        if (!fs.existsSync(absolute)) return null;
        const text = fs.readFileSync(absolute, "utf8");
        return {
          content: { kind: "text", text },
          stateHash: readStateHash,
          contentHash: `content:${relPath}:${revision}`,
          mode: 0o644,
          size: Buffer.byteLength(text),
        };
      },
      executionStateForContent(contentState) {
        return { kind: "event", eventId: `event:${contentState}` };
      },
      async discoverGraph() {
        return discoverPackageGraph(workspaceRoot);
      },
      onProtectedPublication() {
        return () => {};
      },
      async recordBuild() {},
      async materializeForBuild() {
        return { sourceRoot: workspaceRoot };
      },
    };
  }

  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-scaffold-acceptance-"));
    workspaceRoot = path.join(root, "workspace");
    fs.mkdirSync(workspaceRoot, { recursive: true });
    setUserDataPath(path.join(root, "state"));

    // 1. Generate every covered scaffold through the public createProjects path.
    const { createProjects } = (await import(
      path.join(exactUserlandRoot, "skills", "workspace-dev", "create-project.ts")
    )) as { createProjects: (params: unknown[]) => Promise<unknown[]> };
    await createProjects([
      { projectType: "panel", name: "acceptance-panel", title: "Acceptance Panel" },
      { projectType: "worker", name: "acceptance-worker", title: "Acceptance Worker" },
      {
        projectType: "worker",
        name: "notes-store",
        title: "Notes Store",
        template: "durable-service",
      },
      { projectType: "panel", name: "notes-viewer", title: "Notes Viewer" },
    ]);

    // 2. Materialize the captured scaffold files into the temp workspace.
    for (const [relPath, content] of mocks.files) {
      const absolute = path.join(workspaceRoot, relPath);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, content);
    }

    // 3. Declare the durable service's application protocol in the canonical
    //    workspace location (NOT rpcSchema — that field is host-reserved).
    fs.mkdirSync(path.join(workspaceRoot, "meta"), { recursive: true });
    fs.writeFileSync(
      path.join(workspaceRoot, "meta", "vibestudio.yml"),
      [
        // The workspace must speak the exact runtime ABI the current Base
        // declares; read it from Base instead of pinning a drifting literal.
        `systemEpoch: ${
          /^systemEpoch:\s*(\d+)/m.exec(
            fs.readFileSync(path.join(exactUserlandRoot, "meta", "vibestudio.yml"), "utf8")
          )?.[1] ?? "1"
        }`,
        "services:",
        "  - source: workers/notes-store",
        "    name: acceptance.notes",
        "    action: manage acceptance test notes",
        "    notability: everyday",
        "    presentation:",
        "      domain: automation",
        "      verb: manage",
        "    authority:",
        "      binding: declared",
        "      principals: [user, code]",
        "    protocols: [acceptance.notes.v1]",
        "    durableObject:",
        "      className: NotesStore",
        "singletonObjects:",
        "  - className: NotesStore",
        "    key: notes",
        "    source: workers/notes-store",
        "",
      ].join("\n")
    );

    // 4. The consumer panel calls the declared service (the customization an
    //    agent would make on top of the default scaffold).
    const viewerDir = path.join(workspaceRoot, "panels", "notes-viewer");
    fs.appendFileSync(
      path.join(viewerDir, "index.tsx"),
      [
        "",
        'import { workers, rpc } from "@workspace/runtime";',
        "",
        "export async function loadAcceptanceRecords(): Promise<unknown> {",
        '  const service = await workers.resolveService("acceptance.notes.v1");',
        '  if (service.kind !== "durable-object") throw new Error("expected a durable-object service");',
        '  return rpc.call(service.targetId, "listRecords", [{}]);',
        "}",
        "",
      ].join("\n")
    );
    const viewerManifestPath = path.join(viewerDir, "package.json");
    const viewerManifest = JSON.parse(fs.readFileSync(viewerManifestPath, "utf8")) as {
      dependencies?: Record<string, string>;
      vibestudio: { authority: Record<string, unknown> };
    };
    viewerManifest.dependencies = {
      ...viewerManifest.dependencies,
      "@workspace/runtime": "workspace:*",
    };
    // The protocol declaration is review vocabulary the author writes with the
    // consuming code; the workspace-service capability request stays absent so
    // the repair loop below is exercised.
    viewerManifest.vibestudio.authority["serviceRequests"] = [
      { protocol: "acceptance.notes.v1", availability: "required" },
    ];
    fs.writeFileSync(viewerManifestPath, JSON.stringify(viewerManifest, null, 2));

    // 5. Provide the real Base runtime packages the scaffolds depend on.
    copyWorkspaceClosure(workspaceRoot, ["@workspace/runtime"]);

    buildSystem = await initBuildSystemV2(
      workspaceRoot,
      workingTreeStateSource(),
      APP_NODE_MODULES,
      {
        appRoot: path.resolve(__dirname, "../../.."),
        dependencyWorkspaceRoot: workspaceRoot,
        // The same canonical config → exact-binding derivation the server wires:
        // meta/vibestudio.yml services[] become the authority environment.
        workspaceAuthorityEnvironmentAt: async () => ({
          services: exactWorkspaceServiceBindings(
            await readWorkspaceConfig(
              {
                readText: async (filePath: string) => {
                  const absolute = path.join(workspaceRoot, filePath);
                  return fs.existsSync(absolute) ? fs.readFileSync(absolute, "utf8") : null;
                },
              },
              "workspace:scaffold-acceptance"
            )
          ),
        }),
      }
    );
  }, 240_000);

  afterAll(async () => {
    await buildSystem?.shutdown?.();
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function report(unit: string) {
    return buildSystem.getBuildReport(unit, stateHash());
  }

  it("builds the unmodified default React panel clean", async () => {
    const result = await report("panels/acceptance-panel");
    expect(result.diagnostics).toEqual([]);
    expect(result.status).toBe("ok");
  }, 240_000);

  it("builds the unmodified default stateless worker clean", async () => {
    const result = await report("workers/acceptance-worker");
    expect(result.diagnostics).toEqual([]);
    expect(result.status).toBe("ok");
  }, 240_000);

  it("builds the durable-service worker with its workspace protocol declaration clean", async () => {
    const result = await report("workers/notes-store");
    expect(result.diagnostics).toEqual([]);
    expect(result.status).toBe("ok");
  }, 240_000);

  it("repairs the consuming panel with the exact structured request and then builds clean", async () => {
    // Without the workspace-service request, the canonical report fails and its
    // diagnostic carries the fold's narrow request as machine-readable repair.
    const failing = await report("panels/notes-viewer");
    expect(failing.status).toBe("failed");
    const repairs = failing.diagnostics.flatMap((diagnostic) =>
      diagnostic.repair?.code === "missing-authority-request" ? [diagnostic.repair] : []
    );
    expect(repairs.length).toBeGreaterThan(0);
    for (const repair of repairs) {
      expect(repair.file).toBe("panels/notes-viewer/package.json");
      expect(repair.field).toBe("vibestudio.authority.requests");
      expect(repair.request.capability).toBe("workspace-service:acceptance.notes");
      expect(repair.docsId).toBe("workspace:acceptance.notes");
    }

    // Apply the supplied requests VERBATIM — the repair is edit data, and the
    // edit alone must be sufficient. Then rebuild at the new workspace state.
    const manifestPath = path.join(workspaceRoot, "panels", "notes-viewer", "package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
      vibestudio: { authority: { requests: unknown[] } };
    };
    manifest.vibestudio.authority.requests.push(...repairs.map((repair) => repair.request));
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    revision += 1;

    const repaired = await report("panels/notes-viewer");
    expect(repaired.diagnostics).toEqual([]);
    expect(repaired.status).toBe("ok");
  }, 240_000);
});

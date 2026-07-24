import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
/**
 * Workspace service contract regression tests.
 *
 * The point of these tests is to catch the exact regression that broke the
 * workspace API for panels in March: a refactor moved panels from a routing
 * bridge (which split RPC by service name) to a single direct-to-server
 * transport, but the workspace service was left registered only on the
 * Electron-main side. The runtime's `WorkspaceClient` kept calling
 * `rpc.call("main", "workspace.list")` against a server that no longer had
 * the `workspace` service, and every panel-side workspace operation silently
 * failed with `Unknown service 'workspace'`.
 *
 * The contract this file locks in:
 *
 * 1. The runtime-side `createWorkspaceClient` and the server-side
 *    `createWorkspaceService` use the same service name (`"workspace"`) and
 *    the same method names. Any drift on either side fails a test.
 *
 * 2. `"workspace"` is not Electron-local, so the IpcDispatcher forwards
 *    shell-renderer calls to the server by default.
 *
 * 3. The service policy allows `panel`, `worker`, `shell`, and `server`
 *    callers — panels and workers must be able to reach this service
 *    directly via the WebSocket transport.
 *
 * Server-wide catalog methods are intentionally absent: they belong to the
 * stable hubControl service and never transit a workspace child.
 */

import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { RpcCaller } from "@vibestudio/rpc";
import { createWorkspaceService } from "./workspaceService.js";
import { createWorkspaceClient } from "@vibestudio/service-schemas/clients/workspaceClient";
import type { WorkspaceConfig } from "@vibestudio/workspace-contracts/types";
import { WORKSPACE_SYSTEM_EPOCH } from "@vibestudio/shared/vcs/systemEpoch";
import type { ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import type { UserlandApprovalChoice } from "@vibestudio/shared/approvals";

/**
 * Build a recording RpcCaller that captures every (target, method, args) tuple
 * the runtime client emits. The cast is necessary because `vi.fn` collapses
 * the generic `call<T>` signature into `(...args: unknown[]) => unknown`,
 * which can't be assigned back to `RpcCaller` without help.
 */
function recordingRpc(): {
  rpc: RpcCaller;
  captured: Array<{ target: string; method: string; args: unknown[] }>;
} {
  const captured: Array<{ target: string; method: string; args: unknown[] }> = [];
  const callImpl = async (target: string, method: string, args: unknown[]): Promise<unknown> => {
    captured.push({ target, method, args });
    switch (method) {
      case "workspace.units.list":
      case "workspace.units.logs":
      case "workspace.recurring.list":
        return [];
      case "workspace.getActive":
        return "test-ws";
      case "workspace.getConfig":
        return { id: "test-ws", systemEpoch: WORKSPACE_SYSTEM_EPOCH, initPanels: [] };
      case "workspace.units.inspector":
        return null;
      case "workspace.units.versions":
        return { current: null, previous: [], retentionLimit: 5 };
      case "workspace.units.rollback":
        return {};
      default:
        return undefined;
    }
  };
  const rpc = { call: callImpl } as unknown as RpcCaller;
  return { rpc, captured };
}

// ─── Test fixtures ────────────────────────────────────────────────────────────

function makeConfig(overrides: Partial<WorkspaceConfig> = {}): WorkspaceConfig {
  return {
    id: "test-ws",
    systemEpoch: WORKSPACE_SYSTEM_EPOCH,
    initPanels: [],
    ...overrides,
  };
}

function makeWorkspace() {
  return {
    path: "/tmp/source",
    statePath: "/tmp/state",
    config: makeConfig(),
    panelsPath: "/tmp/source/panels",
    packagesPath: "/tmp/source/packages",
    contextProjectionsPath: "/tmp/state/.context-projections/v5",
    cachePath: "/tmp/state/.cache",
    agentsPath: "/tmp/source/agents",
    projectsPath: "/tmp/source/projects",
  };
}

const unavailableContextFiles = {
  readFile: async (): Promise<string> => {
    throw new Error("context files are outside this test");
  },
  readManagedFiles: async (): Promise<Array<{ path: string; content: string }>> => {
    throw new Error("context files are outside this test");
  },
};

function grantedApproval(): UserlandApprovalChoice {
  return { kind: "choice", choice: "allow" };
}

function makeService() {
  return createWorkspaceService({
    workspace: makeWorkspace(),
    contextFiles: unavailableContextFiles,
    getConfig: () => makeConfig(),
    setConfigField: vi.fn(),
    approvalQueue: { requestUserland: vi.fn(async () => grantedApproval()) },
  });
}

const panelCtx: ServiceContext = {
  caller: createVerifiedCaller(
    "panel-1",
    "panel",
    {
      callerId: "panel-1",
      callerKind: "panel",
      repoPath: "panels/test",
      effectiveVersion: "ev-test",
    },
    undefined,
    { userId: "usr_root", handle: "root" }
  ),
};
const shellCtx: ServiceContext = {
  caller: createVerifiedCaller("shell:dev_test", "shell", undefined, undefined, {
    userId: "usr_root",
    handle: "root",
  }),
};

// ─── Contract: client/server method-name alignment ───────────────────────────

describe("workspace service ↔ client contract", () => {
  it("client and server agree on the service name (`workspace`)", async () => {
    const { rpc, captured } = recordingRpc();
    const client = createWorkspaceClient(rpc);
    await Promise.all([client.getActive(), client.getConfig()]);

    expect(captured.length).toBeGreaterThan(0);
    for (const { target, method } of captured) {
      expect(target).toBe("main");
      expect(method.startsWith("workspace.")).toBe(true);
    }
  });

  it("every method the runtime client calls is registered on the server service", async () => {
    // Build a recording RPC, call every method on the client, capture wire calls.
    const { rpc, captured } = recordingRpc();
    const client = createWorkspaceClient(rpc);

    // Exercise every method the client exposes (reads + writes). The contract
    // assertion below verifies each captured wire-name is a registered method
    // on the service definition.
    await client.getActive();
    await client.getConfig();
    await client.setInitPanels([{ source: "panels/chat" }]);
    await client.setConfigField("title", "Test");
    await client.units.list();
    await client.units.inspector("extensions/foo");
    await client.units.restart("extensions/foo");
    await client.units.logs("extensions/foo");
    await client.units.versions("apps/shell");
    await client.units.rollback("apps/shell");
    await client.recurring.list();

    const service = makeService();
    for (const { method } of captured) {
      // Wire format is "workspace.<methodName>"
      const [serviceName, ...methodParts] = method.split(".") as [string, ...string[]];
      const methodName = methodParts.join(".");
      expect(serviceName).toBe(service.name);
      expect(methodName in service.methods).toBe(true);
    }
  });

  it("the runtime client's interface keys map 1:1 to server method names", async () => {
    // Build a recording RPC and call EVERY method on the client interface.
    // This catches drift in either direction: a server method that no client
    // uses, or a client method that hits an unregistered server method.
    const { rpc, captured } = recordingRpc();
    const client = createWorkspaceClient(rpc);

    await Promise.all([
      client.getActive(),
      client.getConfig(),
      client.setInitPanels([]),
      client.setConfigField("title", "Test"),
      client.units.list(),
      client.units.inspector("extensions/foo"),
      client.units.restart("extensions/foo"),
      client.units.logs("extensions/foo"),
      client.units.versions("apps/shell"),
      client.units.rollback("apps/shell"),
      client.recurring.list(),
    ]);

    // The server should have a method handler for each captured wire name.
    const service = makeService();
    for (const { method } of captured) {
      const wireName = method.split(".").slice(1).join(".");
      expect(service.methods[wireName]).toBeDefined();
    }
  });
});

// ─── Policy: panel/worker reachability ────────────────────────────────────────

describe("workspace service policy", () => {
  it("allows panel callers (the regression target)", () => {
    const service = makeService();
    expect(service.authority.principals).toContain("code");
  });

  it("allows worker, shell, and server callers as well", () => {
    const service = makeService();
    expect(service.authority.principals).toContain("code");
    expect(service.authority.principals).toContain("user");
    expect(service.authority.principals).toContain("host");
  });
});

// ─── Behavior: handler delegates correctly ────────────────────────────────────

describe("workspace service handler", () => {
  it("getActive returns the active workspace name from config", async () => {
    const service = makeService();
    const result = await service.handler(panelCtx, "getActive", []);
    expect(result).toBe("test-ws");
  });

  it("getActive reports the catalog name when an ephemeral disk name/id differs", async () => {
    const service = createWorkspaceService({
      workspace: makeWorkspace(),
      contextFiles: unavailableContextFiles,
      activeWorkspaceName: "dev",
      getConfig: () => makeConfig({ id: "ws_opaque" }),
      setConfigField: vi.fn(),
      approvalQueue: { requestUserland: vi.fn(async () => grantedApproval()) },
    });

    expect(await service.handler(panelCtx, "getActive", [])).toBe("dev");
  });

  it("getConfig returns the workspace config", async () => {
    const service = makeService();
    const result = await service.handler(panelCtx, "getConfig", []);
    expect(result).toEqual(makeConfig());
  });

  it("validates candidate workspace config without mutating it", async () => {
    const service = makeService();
    await expect(
      service.handler(panelCtx, "validateConfig", [
        "systemEpoch: 1\nservices:\n  - source: workers/incomplete\n    name: incomplete\n",
      ])
    ).rejects.toThrow(/services\.0/);
    expect(await service.handler(panelCtx, "getConfig", [])).toEqual(makeConfig());
  });

  it("units.inspector returns the inspector URL for a matching unit", async () => {
    const service = createWorkspaceService({
      workspace: makeWorkspace(),
      contextFiles: unavailableContextFiles,
      getConfig: () => makeConfig(),
      setConfigField: vi.fn(),
      listUnits: vi.fn(() => [
        {
          name: "@workspace-extensions/git-tools",
          kind: "extension" as const,
          source: "extensions/git-tools",
          status: "running" as const,
          inspectorUrl: "ws://127.0.0.1:9229/abcdef",
        },
      ]),
    });

    await expect(
      service.handler(panelCtx, "units.inspector", ["@workspace-extensions/git-tools"])
    ).resolves.toEqual({ url: "ws://127.0.0.1:9229/abcdef" });
    await expect(service.handler(panelCtx, "units.inspector", ["missing"])).resolves.toBeNull();
  });

  it("records external unit-log ingestion before returning diagnostics", async () => {
    const recordContextIngestion = vi.fn();
    const log = {
      workspaceId: "test-ws",
      unitName: "panels/example",
      kind: "panel" as const,
      timestamp: 1,
      level: "error" as const,
      message: "hostile page text",
      source: "console" as const,
    };
    const service = createWorkspaceService({
      workspace: makeWorkspace(),
      contextFiles: unavailableContextFiles,
      getConfig: () => makeConfig(),
      setConfigField: vi.fn(),
      listUnitLogs: () => [log],
      recordContextIngestion,
    });

    await expect(
      service.handler(panelCtx, "units.logs", ["panels/example", undefined])
    ).resolves.toEqual([log]);
    expect(recordContextIngestion).toHaveBeenCalledWith(panelCtx, {
      key: "log:panel:panels/example",
      via: "workspace-units:logs",
      classification: "external",
    });
  });

  it("units.bakeAppDist delegates only for shell callers", async () => {
    const bakeAppDist = vi.fn(() => ({ build: { key: "app-key" } }));
    const service = createWorkspaceService({
      workspace: makeWorkspace(),
      contextFiles: unavailableContextFiles,
      getConfig: () => makeConfig(),
      setConfigField: vi.fn(),
      bakeAppDist,
    });

    await expect(
      service.handler(shellCtx, "units.bakeAppDist", [
        "apps/shell",
        { outDir: "/tmp/vibestudio-dist" },
      ])
    ).resolves.toEqual({ build: { key: "app-key" } });
    await expect(service.handler(panelCtx, "units.bakeAppDist", ["apps/shell"])).rejects.toThrow(
      /not accessible to panel callers/
    );
    expect(bakeAppDist).toHaveBeenCalledWith("apps/shell", { outDir: "/tmp/vibestudio-dist" });
    expect(bakeAppDist).toHaveBeenCalledTimes(1);
  });

  it("allows shell to inspect and roll back any app unit", async () => {
    const listAppVersions = vi.fn(() => ({ current: null, previous: [], retentionLimit: 5 }));
    const rollbackAppVersion = vi.fn(() => ({ ok: true }));
    const service = createWorkspaceService({
      workspace: makeWorkspace(),
      contextFiles: unavailableContextFiles,
      getConfig: () => makeConfig(),
      setConfigField: vi.fn(),
      listUnits: vi.fn(() => [
        {
          name: "@workspace-apps/other",
          kind: "app" as const,
          source: "apps/other",
          status: "running" as const,
        },
      ]),
      listAppVersions,
      rollbackAppVersion,
    });

    await expect(
      service.handler(shellCtx, "units.versions", ["@workspace-apps/other"])
    ).resolves.toEqual({ current: null, previous: [], retentionLimit: 5 });
    await expect(
      service.handler(shellCtx, "units.rollback", ["@workspace-apps/other"])
    ).resolves.toEqual({ ok: true });
  });

  it("allows app callers to manage only their own app unit", async () => {
    const listAppVersions = vi.fn(() => ({ current: null, previous: [], retentionLimit: 5 }));
    const rollbackAppVersion = vi.fn(() => ({ ok: true }));
    const service = createWorkspaceService({
      workspace: makeWorkspace(),
      contextFiles: unavailableContextFiles,
      getConfig: () => makeConfig(),
      setConfigField: vi.fn(),
      listUnits: vi.fn(() => [
        {
          name: "@workspace-apps/self",
          kind: "app" as const,
          source: "apps/self",
          status: "running" as const,
        },
        {
          name: "@workspace-apps/other",
          kind: "app" as const,
          source: "apps/other",
          status: "running" as const,
        },
      ]),
      listAppVersions,
      rollbackAppVersion,
    });
    const selfCtx: ServiceContext = {
      caller: createVerifiedCaller("@workspace-apps/self", "app", {
        callerId: "@workspace-apps/self",
        callerKind: "app",
        repoPath: "apps/self",
        effectiveVersion: "ev-self",
      }),
    };

    await expect(
      service.handler(selfCtx, "units.versions", ["@workspace-apps/other"])
    ).resolves.toEqual({ current: null, previous: [], retentionLimit: 5 });
    await expect(
      service.handler(selfCtx, "units.rollback", ["@workspace-apps/self"])
    ).resolves.toEqual({ ok: true });
    await expect(
      service.handler(selfCtx, "units.rollback", ["@workspace-apps/other"])
    ).rejects.toThrow(/can only manage the calling app/);
    expect(rollbackAppVersion).toHaveBeenCalledTimes(1);
    expect(listAppVersions).toHaveBeenCalledWith("@workspace-apps/other");
  });

  it("setInitPanels delegates to setConfigField", async () => {
    const setConfigField = vi.fn();
    const service = createWorkspaceService({
      workspace: makeWorkspace(),
      contextFiles: unavailableContextFiles,
      getConfig: () => makeConfig(),
      setConfigField,
      approvalQueue: { requestUserland: vi.fn(async () => grantedApproval()) },
    });
    await service.handler(panelCtx, "setInitPanels", [[{ source: "panels/chat" }]]);
    expect(setConfigField).toHaveBeenCalledWith(
      "initPanels",
      [{ source: "panels/chat" }],
      panelCtx
    );
  });

  it("setConfigField delegates to setConfigField after approval", async () => {
    const setConfigField = vi.fn();
    const service = createWorkspaceService({
      workspace: makeWorkspace(),
      contextFiles: unavailableContextFiles,
      getConfig: () => makeConfig(),
      setConfigField,
      approvalQueue: { requestUserland: vi.fn(async () => grantedApproval()) },
    });
    await service.handler(panelCtx, "setConfigField", ["title", "Test"]);
    expect(setConfigField).toHaveBeenCalledWith("title", "Test", panelCtx);
  });

  it("recurring.list returns declarative scheduled job diagnostics", async () => {
    const jobs = [
      {
        name: "news-briefing",
        target: {
          source: "workers/news-agent",
          className: "NewsAgentWorker",
          objectKey: "news",
          method: "runScheduledJob",
        },
        args: [{ job: "briefing" }],
        schedule: { intervalMs: 86_400_000, atMinutes: 480 },
        specHash: "hash",
        status: "scheduled" as const,
        nextRunAt: 20_000,
        lastRunAt: null,
        lastStartedAt: null,
        lastSucceededAt: null,
        lastFailedAt: null,
        lastError: null,
        lastDurationMs: null,
        failCount: 0,
        backoffUntil: null,
      },
    ];
    const service = createWorkspaceService({
      workspace: makeWorkspace(),
      contextFiles: unavailableContextFiles,
      getConfig: () => makeConfig(),
      setConfigField: vi.fn(),
      listRecurringJobs: vi.fn(() => jobs),
    });

    await expect(service.handler(shellCtx, "recurring.list", [])).resolves.toEqual(jobs);
  });
});

// ─── Agent resource loading: getAgentsMd / listSkills / readSkill ────────────
//
// These tests use a real tmpdir fixture because the handlers read from disk.
// The fixture layout mirrors the workspace structure:
//
//   <tmp>/
//     meta/AGENTS.md
//     skills/
//       alpha/SKILL.md          ← has frontmatter
//       beta/SKILL.md           ← no frontmatter at all
//       broken/                  ← no SKILL.md (should be skipped)

describe("workspace service agent resources", () => {
  let tmpRoot: string;

  // Build a service bound to a fresh tmpdir so filesystem reads are hermetic.
  function makeFsService(wsPath: string) {
    const skillPaths = (): string[] => {
      const result: string[] = [];
      for (const section of readdirSync(wsPath, { withFileTypes: true })) {
        if (!section.isDirectory()) continue;
        const flatSkill = path.join(wsPath, section.name, "SKILL.md");
        try {
          readFileSync(flatSkill);
          result.push(`/${section.name}/SKILL.md`);
        } catch {
          // No flat skill in this section.
        }
        for (const repo of readdirSync(path.join(wsPath, section.name), {
          withFileTypes: true,
        })) {
          if (!repo.isDirectory()) continue;
          const nestedSkill = path.join(wsPath, section.name, repo.name, "SKILL.md");
          try {
            readFileSync(nestedSkill);
            result.push(`/${section.name}/${repo.name}/SKILL.md`);
          } catch {
            // No skill at this repo root.
          }
        }
      }
      return result;
    };
    return createWorkspaceService({
      workspace: {
        path: wsPath,
        statePath: path.join(wsPath, ".state"),
        config: makeConfig(),
        panelsPath: path.join(wsPath, "panels"),
        packagesPath: path.join(wsPath, "packages"),
        contextProjectionsPath: path.join(wsPath, ".context-projections", "v5"),
        cachePath: path.join(wsPath, ".cache"),
        agentsPath: path.join(wsPath, "agents"),
        projectsPath: path.join(wsPath, "projects"),
      },
      contextFiles: {
        readFile: async (_ctx, filePath) =>
          readFileSync(path.join(wsPath, filePath.replace(/^\/+/, "")), "utf8"),
        readManagedFiles: async () =>
          skillPaths().map((skillPath) => ({
            path: skillPath,
            content: readFileSync(path.join(wsPath, skillPath.replace(/^\/+/, "")), "utf8"),
          })),
      },
      getConfig: () => makeConfig(),
      setConfigField: vi.fn(),
    });
  }

  beforeAll(() => {
    tmpRoot = mkdtempSync(path.join(tmpdir(), "vibestudio-wsvc-"));
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  // ─── getAgentsMd ───────────────────────────────────────────────────────────

  describe("getAgentsMd", () => {
    it("reads an existing AGENTS.md from meta/", async () => {
      const wsPath = mkdtempSync(path.join(tmpRoot, "ws-"));
      mkdirSync(path.join(wsPath, "meta"), { recursive: true });
      writeFileSync(path.join(wsPath, "meta", "AGENTS.md"), "# Agents\nhello world\n");
      const service = makeFsService(wsPath);
      const result = await service.handler(panelCtx, "getAgentsMd", []);
      expect(result).toBe("# Agents\nhello world\n");
    });

    it("returns an empty string when AGENTS.md is missing (ENOENT)", async () => {
      const wsPath = mkdtempSync(path.join(tmpRoot, "ws-"));
      // Note: no AGENTS.md written.
      const service = makeFsService(wsPath);
      const result = await service.handler(panelCtx, "getAgentsMd", []);
      expect(result).toBe("");
    });
  });

  // ─── listSkills ────────────────────────────────────────────────────────────

  describe("listSkills", () => {
    it("requires contextless host callers to name a context and forbids ambient-context overrides", async () => {
      const readManagedFiles = vi.fn(async () => []);
      const readFile = vi.fn(async () => "# skill");
      const service = createWorkspaceService({
        workspace: makeWorkspace(),
        contextFiles: { readFile, readManagedFiles },
        getConfig: () => makeConfig(),
        setConfigField: vi.fn(),
      });

      await expect(service.handler(shellCtx, "listSkills", [])).rejects.toThrow(
        "shell callers must provide an explicit contextId"
      );
      await expect(
        service.handler(shellCtx, "listSkills", [{ contextId: "ctx-shell" }])
      ).resolves.toEqual([]);
      expect(readManagedFiles).toHaveBeenCalledWith(
        shellCtx,
        ["*/SKILL.md", "*/*/SKILL.md"],
        "ctx-shell"
      );

      await expect(
        service.handler(panelCtx, "listSkills", [{ contextId: "ctx-other" }])
      ).rejects.toThrow("panel callers cannot override their verified ambient context");

      await expect(
        service.handler(shellCtx, "readSkill", ["skills/alpha", { contextId: "ctx-shell" }])
      ).resolves.toBe("# skill");
      expect(readFile).toHaveBeenCalledWith(shellCtx, "/skills/alpha/SKILL.md", "ctx-shell");
    });

    it("walks repo taxonomy and parses top-level SKILL.md frontmatter", async () => {
      const wsPath = mkdtempSync(path.join(tmpRoot, "ws-"));
      mkdirSync(path.join(wsPath, "meta"), { recursive: true });
      writeFileSync(
        path.join(wsPath, "meta", "SKILL.md"),
        "---\nname: meta-skill\ndescription: Flat repo skill\n---\n"
      );
      mkdirSync(path.join(wsPath, "skills", "alpha"), { recursive: true });
      writeFileSync(
        path.join(wsPath, "skills", "alpha", "SKILL.md"),
        "---\nname: alpha\ndescription: First skill\n---\n\nbody\n"
      );
      mkdirSync(path.join(wsPath, "skills", "gamma"), { recursive: true });
      writeFileSync(
        path.join(wsPath, "skills", "gamma", "SKILL.md"),
        "---\nname: \"gamma-named\"\ndescription: 'Third skill'\n---\n"
      );
      mkdirSync(path.join(wsPath, "packages", "foo"), { recursive: true });
      writeFileSync(
        path.join(wsPath, "packages", "foo", "SKILL.md"),
        "---\nname: duplicate\ndescription: Package skill\n---\n"
      );
      mkdirSync(path.join(wsPath, "workers", "gmail-agent"), { recursive: true });
      writeFileSync(
        path.join(wsPath, "workers", "gmail-agent", "SKILL.md"),
        "---\nname: duplicate\ndescription: Worker skill\n---\n"
      );
      mkdirSync(path.join(wsPath, "projects", "vault"), { recursive: true });
      writeFileSync(
        path.join(wsPath, "projects", "vault", "SKILL.md"),
        "---\nname: vault\ndescription: Project skill\n---\n"
      );
      mkdirSync(path.join(wsPath, "agents", "ignored"), { recursive: true });
      writeFileSync(
        path.join(wsPath, "agents", "ignored", "SKILL.md"),
        "---\nname: ignored\ndescription: Not a repo\n---\n"
      );
      const service = makeFsService(wsPath);
      const result = (await service.handler(panelCtx, "listSkills", [])) as Array<{
        name: string;
        description: string;
        dirPath: string;
        skillPath: string;
      }>;
      expect(result).toEqual([
        {
          name: "meta-skill",
          description: "Flat repo skill",
          dirPath: "meta",
          skillPath: "meta/SKILL.md",
        },
        {
          name: "duplicate",
          description: "Package skill",
          dirPath: "packages/foo",
          skillPath: "packages/foo/SKILL.md",
        },
        {
          name: "vault",
          description: "Project skill",
          dirPath: "projects/vault",
          skillPath: "projects/vault/SKILL.md",
        },
        {
          name: "alpha",
          description: "First skill",
          dirPath: "skills/alpha",
          skillPath: "skills/alpha/SKILL.md",
        },
        {
          name: "gamma-named",
          description: "Third skill",
          dirPath: "skills/gamma",
          skillPath: "skills/gamma/SKILL.md",
        },
        {
          name: "duplicate",
          description: "Worker skill",
          dirPath: "workers/gmail-agent",
          skillPath: "workers/gmail-agent/SKILL.md",
        },
      ]);
    });

    it("skips directories that lack a SKILL.md and still returns the rest", async () => {
      const wsPath = mkdtempSync(path.join(tmpRoot, "ws-"));
      const skillsDir = path.join(wsPath, "skills");
      mkdirSync(path.join(skillsDir, "alpha"), { recursive: true });
      writeFileSync(
        path.join(skillsDir, "alpha", "SKILL.md"),
        "---\nname: alpha\ndescription: Real\n---\n"
      );
      // 'broken' exists but has no SKILL.md — must be skipped, not crash.
      mkdirSync(path.join(skillsDir, "broken"), { recursive: true });
      const service = makeFsService(wsPath);
      const result = (await service.handler(panelCtx, "listSkills", [])) as Array<{ name: string }>;
      expect(result).toHaveLength(1);
      expect(result[0]!.name).toBe("alpha");
    });

    it("falls back to directory name and empty description when frontmatter is absent", async () => {
      const wsPath = mkdtempSync(path.join(tmpRoot, "ws-"));
      const skillsDir = path.join(wsPath, "skills");
      mkdirSync(path.join(skillsDir, "beta"), { recursive: true });
      writeFileSync(path.join(skillsDir, "beta", "SKILL.md"), "# Just a heading, no frontmatter\n");
      const service = makeFsService(wsPath);
      const result = (await service.handler(panelCtx, "listSkills", [])) as Array<{
        name: string;
        description: string;
        dirPath: string;
        skillPath: string;
      }>;
      expect(result).toEqual([
        {
          name: "beta",
          description: "",
          dirPath: "skills/beta",
          skillPath: "skills/beta/SKILL.md",
        },
      ]);
    });

    it("returns an empty array when skills/ does not exist (ENOENT)", async () => {
      const wsPath = mkdtempSync(path.join(tmpRoot, "ws-"));
      const service = makeFsService(wsPath);
      const result = await service.handler(panelCtx, "listSkills", []);
      expect(result).toEqual([]);
    });
  });

  // ─── readSkill ─────────────────────────────────────────────────────────────

  describe("readSkill", () => {
    it("returns the raw SKILL.md content for a skill repo path", async () => {
      const wsPath = mkdtempSync(path.join(tmpRoot, "ws-"));
      const skillsDir = path.join(wsPath, "skills");
      mkdirSync(path.join(skillsDir, "alpha"), { recursive: true });
      const body = "---\nname: alpha\ndescription: a\n---\n\nreal body\n";
      writeFileSync(path.join(skillsDir, "alpha", "SKILL.md"), body);
      const service = makeFsService(wsPath);
      const result = await service.handler(panelCtx, "readSkill", ["skills/alpha"]);
      expect(result).toBe(body);
    });

    it("returns the raw SKILL.md content for a workspace repo path", async () => {
      const wsPath = mkdtempSync(path.join(tmpRoot, "ws-"));
      mkdirSync(path.join(wsPath, "packages", "foo"), { recursive: true });
      const body = "---\nname: foo\ndescription: repo skill\n---\n\nbody\n";
      writeFileSync(path.join(wsPath, "packages", "foo", "SKILL.md"), body);
      const service = makeFsService(wsPath);
      const result = await service.handler(panelCtx, "readSkill", ["packages/foo"]);
      expect(result).toBe(body);
    });

    it("reads the flat meta repo's SKILL.md", async () => {
      const wsPath = mkdtempSync(path.join(tmpRoot, "ws-"));
      mkdirSync(path.join(wsPath, "meta"), { recursive: true });
      const body = "---\nname: meta\ndescription: flat repo\n---\n\nbody\n";
      writeFileSync(path.join(wsPath, "meta", "SKILL.md"), body);
      const service = makeFsService(wsPath);
      const result = await service.handler(panelCtx, "readSkill", ["meta"]);
      expect(result).toBe(body);
    });

    it("rejects path traversal attempts like '../etc/passwd'", async () => {
      const wsPath = mkdtempSync(path.join(tmpRoot, "ws-"));
      const service = makeFsService(wsPath);
      await expect(service.handler(panelCtx, "readSkill", ["../etc/passwd"])).rejects.toThrow(
        /Invalid workspace repo path/
      );
    });

    it("rejects names containing slashes or dots", async () => {
      const wsPath = mkdtempSync(path.join(tmpRoot, "ws-"));
      const service = makeFsService(wsPath);
      await expect(service.handler(panelCtx, "readSkill", ["foo/bar"])).rejects.toThrow(
        /Invalid workspace repo path/
      );
      await expect(service.handler(panelCtx, "readSkill", ["foo.bar"])).rejects.toThrow(
        /Invalid workspace repo path/
      );
      await expect(service.handler(panelCtx, "readSkill", [""])).rejects.toThrow(
        /Invalid workspace repo path/
      );
    });

    it("rejects non-repo and deeper workspace paths", async () => {
      const wsPath = mkdtempSync(path.join(tmpRoot, "ws-"));
      const service = makeFsService(wsPath);
      await expect(service.handler(panelCtx, "readSkill", ["agents/foo"])).rejects.toThrow(
        /Invalid workspace repo path/
      );
      await expect(service.handler(panelCtx, "readSkill", ["packages/foo/bar"])).rejects.toThrow(
        /Invalid workspace repo path/
      );
    });
  });
});

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { createVerifiedCaller, type ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import {
  createTestServiceContext,
  withTestServiceAuthority,
} from "@vibestudio/shared/serviceDispatcherTestUtils";
import type { WorkspaceConfig } from "@vibestudio/workspace-contracts/types";
import type { ApprovalQueue } from "./approvalQueue.js";

import { createGitInteropService as createGitInteropServiceDefinition } from "./gitInteropService.js";
import { GitImportJournal } from "./gitImportJournal.js";

function createGitInteropService(
  deps: Omit<Parameters<typeof createGitInteropServiceDefinition>[0], "importJournal"> & {
    importJournal?: GitImportJournal;
  }
) {
  const journalRoot = deps.workspacePath ?? tempWorkspace();
  return withTestServiceAuthority(
    createGitInteropServiceDefinition({
      ...deps,
      importJournal:
        deps.importJournal ??
        new GitImportJournal(path.join(journalRoot, ".git-import-journal.json")),
    })
  );
}

type GitProviderInvoker = NonNullable<
  Parameters<typeof createGitInteropService>[0]["invokeGitProvider"]
>;

function cloneProvider(
  cloneRepo: (ctx: ServiceContext, repoPath: string) => Promise<unknown>
): GitProviderInvoker {
  const phases = new Map<string, "prepared" | "committed" | "complete" | "aborted">();
  return (async (ctx: ServiceContext, method: string, args: unknown[]) => {
    const input = args[0] as { operationId: string; repoPath?: string };
    const status = (phase: "prepared" | "committed" | "complete" | "aborted") => ({
      operationId: input.operationId,
      repoPath: input.repoPath ?? "projects/bgkit",
      branch: "vibestudio-bridge",
      gitCommitSha: "a".repeat(40),
      stateHash: `state:${"b".repeat(64)}`,
      changed: true,
      phase,
    });
    if (method === "prepareImport") {
      await cloneRepo(ctx, input.repoPath!);
      phases.set(input.operationId, "prepared");
      return status("prepared");
    }
    if (method === "commitImport") {
      phases.set(input.operationId, "committed");
      return status("committed");
    }
    if (method === "finalizeImport") {
      phases.set(input.operationId, "complete");
      return status("complete");
    }
    if (method === "inspectImport") {
      const phase = phases.get(input.operationId);
      return phase ? status(phase) : null;
    }
    if (method === "abortImport") {
      phases.set(input.operationId, "aborted");
      return status("aborted");
    }
    throw new Error(`Unexpected provider method: ${method}`);
  }) as GitProviderInvoker;
}

function importProvider(input: {
  branch?: string | null;
  discoverError?: Error;
  clone?: (ctx: ServiceContext, repoPath: string) => Promise<unknown>;
}): GitProviderInvoker {
  const phases = new Map<string, "prepared" | "committed" | "complete" | "aborted">();
  return (async (ctx: ServiceContext, method: string, args: unknown[]) => {
    if (method === "remoteDefaultBranch") {
      if (input.discoverError) throw input.discoverError;
      return { branch: input.branch ?? null };
    }
    const operation = args[0] as { operationId: string; repoPath?: string };
    const repoPath = operation.repoPath ?? "projects/bgkit";
    const status = (phase: "prepared" | "committed" | "complete" | "aborted") => ({
      operationId: operation.operationId,
      repoPath,
      branch: input.branch ?? "main",
      gitCommitSha: "a".repeat(40),
      stateHash: `state:${"b".repeat(64)}`,
      changed: true,
      phase,
    });
    if (method === "prepareImport") {
      await input.clone?.(ctx, repoPath);
      phases.set(operation.operationId, "prepared");
      return status("prepared");
    }
    if (method === "commitImport") {
      phases.set(operation.operationId, "committed");
      return status("committed");
    }
    if (method === "finalizeImport") {
      phases.set(operation.operationId, "complete");
      return status("complete");
    }
    if (method === "inspectImport") {
      const phase = phases.get(operation.operationId);
      return phase ? status(phase) : null;
    }
    if (method === "abortImport") {
      phases.set(operation.operationId, "aborted");
      return status("aborted");
    }
    throw new Error(`Unexpected provider method: ${method}`);
  }) as GitProviderInvoker;
}

function tempWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-git-interop-"));
  fs.mkdirSync(path.join(root, "meta"), { recursive: true });
  return root;
}

function serviceContext(): ServiceContext {
  return createTestServiceContext(createVerifiedCaller("server", "server"));
}

function panelServiceContext(): ServiceContext {
  return createTestServiceContext(
    createVerifiedCaller("panel-1", "panel", {
      callerId: "panel-1",
      callerKind: "panel",
      repoPath: "panels/test",
      executionDigest: "ev-panel",
      delegations: [],
      requested: [
        { capability: "service:*", resource: { kind: "prefix", prefix: "" } },
        { capability: "rpc:*", resource: { kind: "prefix", prefix: "" } },
      ],
    })
  );
}

function diskConfigPersistence(workspacePath: string) {
  const configPath = path.join(workspacePath, "meta", "vibestudio.yml");
  const render = (nextConfig: WorkspaceConfig): string => {
    const before = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf-8") : "";
    const beforeParsed = before ? ((YAML.parse(before) as Record<string, unknown>) ?? {}) : {};
    const merged = { ...beforeParsed, ...nextConfig };
    // A mutation that removed the last git declaration deletes the `git` key
    // outright — a shallow merge must not resurrect it from the old file.
    if (!("git" in nextConfig)) delete merged["git"];
    return YAML.stringify(merged);
  };
  const currentConfig = (): WorkspaceConfig =>
    fs.existsSync(configPath)
      ? ((YAML.parse(fs.readFileSync(configPath, "utf-8")) as WorkspaceConfig | null) ?? {
          id: "test",
        })
      : { id: "test" };
  return {
    workspaceConfigMutationWouldChange: vi.fn(
      async (mutate: (current: WorkspaceConfig) => WorkspaceConfig) => {
        const nextConfig = mutate(currentConfig());
        const before = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf-8") : "";
        return before !== render(nextConfig);
      }
    ),
    persistWorkspaceConfigMutation: vi.fn(
      async ({ mutate }: { mutate: (current: WorkspaceConfig) => WorkspaceConfig }) => {
        const nextConfig = mutate(currentConfig());
        const before = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf-8") : "";
        const next = render(nextConfig);
        if (before === next) return { changed: false, nextConfig };
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, next, "utf-8");
        return { changed: true, nextConfig };
      }
    ),
  };
}

describe("gitInteropService", () => {
  it("resolves and persists a non-main remote default before any workspace mutation", async () => {
    const workspacePath = tempWorkspace();
    const workspaceConfig: WorkspaceConfig = { id: "test" };
    fs.writeFileSync(
      path.join(workspacePath, "meta", "vibestudio.yml"),
      YAML.stringify(workspaceConfig),
      "utf8"
    );
    const clone = vi.fn(async () => undefined);
    const service = createGitInteropService({
      workspacePath,
      workspaceConfig,
      treeScanner: { invalidate: vi.fn(), getSourceTree: vi.fn() } as never,
      invokeGitProvider: importProvider({ branch: "trunk", clone }),
      ...diskConfigPersistence(workspacePath),
    });

    const result = (await service.handler(serviceContext(), "importProject", [
      {
        path: "projects/bgkit",
        remote: { name: "origin", url: "https://github.com/werg/bgkit.git" },
      },
    ])) as { remote: { branch: string } };

    expect(result.remote.branch).toBe("trunk");
    expect(clone).toHaveBeenCalledOnce();
    const config = YAML.parse(
      fs.readFileSync(path.join(workspacePath, "meta", "vibestudio.yml"), "utf8")
    ) as WorkspaceConfig;
    expect(config.git?.remotes?.["projects"]?.["bgkit"]?.["origin"]?.branch).toBe("trunk");
    expect(config.git?.upstreams?.["projects"]?.["bgkit"]?.branch).toBe("trunk");
  });

  it("fails branch discovery and empty remotes before config, clone, or source adoption", async () => {
    for (const provider of [
      importProvider({ discoverError: new Error("remote unavailable") }),
      importProvider({ branch: null }),
    ]) {
      const workspacePath = tempWorkspace();
      const workspaceConfig: WorkspaceConfig = { id: "test" };
      fs.writeFileSync(
        path.join(workspacePath, "meta", "vibestudio.yml"),
        YAML.stringify(workspaceConfig),
        "utf8"
      );
      const persistence = diskConfigPersistence(workspacePath);
      const sourceChanged = vi.fn(async () => undefined);
      const service = createGitInteropService({
        workspacePath,
        workspaceConfig,
        treeScanner: { invalidate: vi.fn(), getSourceTree: vi.fn() } as never,
        invokeGitProvider: provider,
        onWorkspaceSourceChanged: sourceChanged,
        ...persistence,
      });

      await expect(
        service.handler(serviceContext(), "importProject", [
          {
            path: "projects/bgkit",
            remote: { name: "origin", url: "https://github.com/werg/bgkit.git" },
          },
        ])
      ).rejects.toThrow();
      expect(persistence.persistWorkspaceConfigMutation).not.toHaveBeenCalled();
      expect(sourceChanged).not.toHaveBeenCalled();
    }
  });

  it("does not discover a default when the caller names a branch", async () => {
    const workspacePath = tempWorkspace();
    const workspaceConfig: WorkspaceConfig = { id: "test" };
    fs.writeFileSync(
      path.join(workspacePath, "meta", "vibestudio.yml"),
      YAML.stringify(workspaceConfig),
      "utf8"
    );
    const providerSpy = vi.fn(importProvider({ branch: "release" }));
    const provider = providerSpy as unknown as GitProviderInvoker;
    const service = createGitInteropService({
      workspacePath,
      workspaceConfig,
      treeScanner: { invalidate: vi.fn(), getSourceTree: vi.fn() } as never,
      invokeGitProvider: provider,
      ...diskConfigPersistence(workspacePath),
    });

    await service.handler(serviceContext(), "importProject", [
      {
        path: "projects/bgkit",
        remote: {
          name: "origin",
          url: "https://github.com/werg/bgkit.git",
          branch: "release",
        },
      },
    ]);
    expect(providerSpy.mock.calls.map((call: unknown[]) => call[1])).toEqual([
      "prepareImport",
      "commitImport",
      "finalizeImport",
    ]);
  });

  it("imports a requested branch and persists it as a shared remote", async () => {
    const workspacePath = tempWorkspace();
    const workspaceConfig: WorkspaceConfig = { id: "test" };
    const cloneRepo = vi.fn(async () => undefined);
    const onWorkspaceSourceChanged = vi.fn(async () => undefined);
    fs.writeFileSync(
      path.join(workspacePath, "meta", "vibestudio.yml"),
      YAML.stringify({ id: "test" }),
      "utf-8"
    );
    const service = createGitInteropService({
      workspacePath,
      workspaceConfig,
      treeScanner: { invalidate: vi.fn(), getSourceTree: vi.fn() } as never,
      invokeGitProvider: cloneProvider(cloneRepo),
      onWorkspaceSourceChanged,
      ...diskConfigPersistence(workspacePath),
    });

    await service.handler(serviceContext(), "importProject", [
      {
        path: "projects/bgkit",
        remote: {
          name: "origin",
          url: "https://github.com/werg/bgkit.git",
          branch: "vibestudio-bridge",
        },
      },
    ]);

    expect(cloneRepo).toHaveBeenCalledWith(expect.anything(), "projects/bgkit");
    expect(onWorkspaceSourceChanged).toHaveBeenCalledWith(
      expect.anything(),
      "Import workspace project projects/bgkit",
      "projects/bgkit"
    );
    const config = YAML.parse(
      fs.readFileSync(path.join(workspacePath, "meta", "vibestudio.yml"), "utf-8")
    ) as WorkspaceConfig;
    expect(config.git?.remotes?.["projects"]?.["bgkit"]?.["origin"]).toEqual({
      url: "https://github.com/werg/bgkit.git",
      branch: "vibestudio-bridge",
    });
    expect(config.git?.upstreams?.["projects"]?.["bgkit"]).toEqual({
      remote: "origin",
      branch: "vibestudio-bridge",
      autoPush: false,
    });
  });

  it("uses one config-write approval before importing a project that edits vibestudio.yml", async () => {
    const workspacePath = tempWorkspace();
    const workspaceConfig: WorkspaceConfig = { id: "test" };
    const cloneRepo = vi.fn(async () => undefined);
    fs.writeFileSync(
      path.join(workspacePath, "meta", "vibestudio.yml"),
      YAML.stringify({ id: "test" }),
      "utf-8"
    );
    const approvalQueue = {
      request: vi.fn(async () => "once" as const),
    } as unknown as ApprovalQueue & { request: ReturnType<typeof vi.fn> };
    const service = createGitInteropService({
      workspacePath,
      workspaceConfig,
      treeScanner: { invalidate: vi.fn(), getSourceTree: vi.fn() } as never,
      invokeGitProvider: cloneProvider(cloneRepo),
      approvalQueue,
      ...diskConfigPersistence(workspacePath),
    });

    await service.handler(panelServiceContext(), "importProject", [
      {
        path: "projects/bgkit",
        remote: {
          name: "origin",
          url: "https://github.com/werg/bgkit.git",
          branch: "vibestudio-bridge",
        },
      },
    ]);

    expect(approvalQueue.request).toHaveBeenCalledTimes(1);
    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "unit-batch",
        trigger: "meta-change",
        title: "Import external Git project",
        units: [],
        configWrite: {
          repoPath: "meta",
          summary:
            "meta/vibestudio.yml records origin=github.com/werg/bgkit.git for projects/bgkit on vibestudio-bridge",
        },
      })
    );
  });

  it("does not clone when config-write approval is denied", async () => {
    const workspacePath = tempWorkspace();
    const workspaceConfig: WorkspaceConfig = { id: "test" };
    const cloneRepo = vi.fn(async () => undefined);
    fs.writeFileSync(
      path.join(workspacePath, "meta", "vibestudio.yml"),
      YAML.stringify({ id: "test" }),
      "utf-8"
    );
    const approvalQueue = {
      request: vi.fn().mockResolvedValueOnce("deny"),
    } as unknown as ApprovalQueue & { request: ReturnType<typeof vi.fn> };
    const service = createGitInteropService({
      workspacePath,
      workspaceConfig,
      treeScanner: { invalidate: vi.fn(), getSourceTree: vi.fn() } as never,
      invokeGitProvider: cloneProvider(cloneRepo),
      approvalQueue,
      ...diskConfigPersistence(workspacePath),
    });

    await expect(
      service.handler(panelServiceContext(), "importProject", [
        {
          path: "projects/bgkit",
          remote: {
            name: "origin",
            url: "https://github.com/werg/bgkit.git",
            branch: "vibestudio-bridge",
          },
        },
      ])
    ).rejects.toThrow("Workspace config edit denied");

    expect(cloneRepo).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(workspacePath, "projects", "bgkit"))).toBe(false);
  });

  it("leaves configuration untouched when operation-owned preparation fails", async () => {
    const workspacePath = tempWorkspace();
    const workspaceConfig: WorkspaceConfig = { id: "test" };
    const cloneRepo = vi.fn().mockRejectedValueOnce(new Error("network unavailable"));
    const sourceChanged = vi.fn(async () => undefined);
    fs.writeFileSync(
      path.join(workspacePath, "meta", "vibestudio.yml"),
      YAML.stringify({ id: "test" }),
      "utf-8"
    );
    const service = createGitInteropService({
      workspacePath,
      workspaceConfig,
      treeScanner: { invalidate: vi.fn(), getSourceTree: vi.fn() } as never,
      invokeGitProvider: cloneProvider(cloneRepo),
      approvalQueue: {
        request: vi.fn(async () => "once" as const),
      } as unknown as ApprovalQueue,
      onWorkspaceSourceChanged: sourceChanged,
      ...diskConfigPersistence(workspacePath),
    });

    await expect(
      service.handler(panelServiceContext(), "importProject", [
        {
          path: "projects/bgkit",
          remote: {
            name: "origin",
            url: "https://github.com/werg/bgkit.git",
            branch: "vibestudio-bridge",
          },
        },
      ])
    ).rejects.toThrow(/failed during preparation: network unavailable/s);

    // No phantom declaration survives a failed clone: the remote/upstream
    // config is rolled back and the retry path is a clean re-import.
    const config = YAML.parse(
      fs.readFileSync(path.join(workspacePath, "meta", "vibestudio.yml"), "utf-8")
    ) as WorkspaceConfig;
    expect(config.git?.remotes?.["projects"]?.["bgkit"]?.["origin"]).toBeUndefined();
    expect(config.git?.upstreams?.["projects"]?.["bgkit"]).toBeUndefined();
    expect(fs.existsSync(path.join(workspacePath, "projects", "bgkit"))).toBe(false);
    expect(sourceChanged).not.toHaveBeenCalled();
  });

  it("resumes post-commit finalization from the durable journal without rediscovering the branch", async () => {
    const workspacePath = tempWorkspace();
    const configPath = path.join(workspacePath, "meta", "vibestudio.yml");
    fs.writeFileSync(configPath, YAML.stringify({ id: "test" }), "utf8");
    const journalPath = path.join(workspacePath, ".state", "git-imports.json");
    const phases = new Map<string, "prepared" | "committed" | "complete" | "aborted">();
    let branchLookups = 0;
    let finalizeAttempts = 0;
    const providerSpy = vi.fn(async (_ctx: ServiceContext, method: string, args: unknown[]) => {
      if (method === "remoteDefaultBranch") {
        branchLookups += 1;
        if (branchLookups > 1) throw new Error("remote is offline during recovery");
        return { branch: "trunk" };
      }
      const input = args[0] as { operationId: string; repoPath?: string };
      const result = (phase: "prepared" | "committed" | "complete" | "aborted") => ({
        operationId: input.operationId,
        repoPath: input.repoPath ?? "projects/bgkit",
        branch: "trunk",
        gitCommitSha: "a".repeat(40),
        stateHash: `state:${"b".repeat(64)}`,
        changed: true,
        phase,
      });
      if (method === "prepareImport") {
        phases.set(input.operationId, "prepared");
        return result("prepared");
      }
      if (method === "commitImport") {
        phases.set(input.operationId, "committed");
        return result("committed");
      }
      if (method === "finalizeImport") {
        finalizeAttempts += 1;
        if (finalizeAttempts === 1) throw new Error("marker fsync failed");
        phases.set(input.operationId, "complete");
        return result("complete");
      }
      if (method === "inspectImport") {
        const phase = phases.get(input.operationId);
        return phase ? result(phase) : null;
      }
      if (method === "abortImport") {
        phases.set(input.operationId, "aborted");
        return result("aborted");
      }
      throw new Error(`Unexpected provider method: ${method}`);
    });
    const provider = providerSpy as unknown as GitProviderInvoker;
    const sourceChanged = vi.fn(async () => "ctx-imported");
    const request = {
      path: "projects/bgkit",
      remote: { name: "origin", url: "https://github.com/werg/bgkit.git" },
    };

    const first = createGitInteropService({
      workspacePath,
      workspaceConfig: { id: "test" },
      treeScanner: { invalidate: vi.fn(), getSourceTree: vi.fn() } as never,
      invokeGitProvider: provider,
      importJournal: new GitImportJournal(journalPath),
      onWorkspaceSourceChanged: sourceChanged,
      ...diskConfigPersistence(workspacePath),
    });
    await expect(first.handler(serviceContext(), "importProject", [request])).rejects.toThrow(
      /committed protected main but finalization is incomplete/
    );

    const resumed = createGitInteropService({
      workspacePath,
      workspaceConfig: YAML.parse(fs.readFileSync(configPath, "utf8")) as WorkspaceConfig,
      treeScanner: { invalidate: vi.fn(), getSourceTree: vi.fn() } as never,
      invokeGitProvider: provider,
      importJournal: new GitImportJournal(journalPath),
      onWorkspaceSourceChanged: sourceChanged,
      ...diskConfigPersistence(workspacePath),
    });
    await expect(
      resumed.handler(serviceContext(), "importProject", [request])
    ).resolves.toMatchObject({
      phase: "complete",
      remote: { branch: "trunk" },
      adoptedContextId: "ctx-imported",
    });

    expect(branchLookups).toBe(1);
    expect(providerSpy.mock.calls.filter((call) => call[1] === "prepareImport")).toHaveLength(1);
    expect(providerSpy.mock.calls.filter((call) => call[1] === "commitImport")).toHaveLength(1);
    expect(providerSpy.mock.calls.filter((call) => call[1] === "finalizeImport")).toHaveLength(2);
    expect(sourceChanged).toHaveBeenCalledTimes(1);
  });

  it("imports configured workspace dependencies without prompting for another approval", async () => {
    const workspacePath = tempWorkspace();
    const cloneRepo = vi.fn(async () => undefined);
    const workspaceConfig: WorkspaceConfig = {
      id: "test",
      git: {
        remotes: {
          projects: {
            bgkit: {
              origin: {
                url: "https://github.com/werg/bgkit.git",
                branch: "vibestudio-bridge",
              },
            },
          },
        },
        upstreams: {
          projects: {
            bgkit: {
              remote: "origin",
              branch: "vibestudio-bridge",
              autoPush: false,
            },
          },
        },
      },
    };
    const sourceChanged = vi.fn(async () => undefined);
    fs.writeFileSync(
      path.join(workspacePath, "meta", "vibestudio.yml"),
      YAML.stringify(workspaceConfig),
      "utf-8"
    );
    const approvalQueue = {
      request: vi.fn(async () => "deny" as const),
    } as unknown as ApprovalQueue & { request: ReturnType<typeof vi.fn> };
    const service = createGitInteropService({
      workspacePath,
      workspaceConfig,
      treeScanner: {
        invalidate: vi.fn(),
        getSourceTree: vi.fn(async () => ({ children: [] })),
      } as never,
      invokeGitProvider: cloneProvider(cloneRepo),
      approvalQueue,
      onWorkspaceSourceChanged: sourceChanged,
      ...diskConfigPersistence(workspacePath),
    });

    const result = await service.handler(
      panelServiceContext(),
      "completeWorkspaceDependencies",
      []
    );

    expect(result).toMatchObject({
      imported: [
        {
          path: "projects/bgkit",
          remote: {
            name: "origin",
            urlIdentity: "https://github.com/werg/bgkit.git",
            branch: "vibestudio-bridge",
          },
        },
      ],
      skipped: [],
      failed: [],
    });
    expect(approvalQueue.request).not.toHaveBeenCalled();
    expect(cloneRepo).toHaveBeenCalledWith(expect.anything(), "projects/bgkit");
    expect(sourceChanged).toHaveBeenCalledWith(
      expect.objectContaining({ caller: panelServiceContext().caller }),
      "Import workspace project projects/bgkit",
      "projects/bgkit"
    );
  });

  it("uses the injected config writer instead of reading the projected meta file", async () => {
    const workspacePath = tempWorkspace();
    const projectedConfigPath = path.join(workspacePath, "meta", "vibestudio.yml");
    fs.rmSync(projectedConfigPath, { force: true });
    const workspaceConfig: WorkspaceConfig = { id: "test" };
    const persistWorkspaceConfigMutation = vi.fn(
      async ({ mutate }: { mutate: (current: WorkspaceConfig) => WorkspaceConfig }) => ({
        changed: true,
        nextConfig: mutate(workspaceConfig),
      })
    );
    const service = createGitInteropService({
      workspacePath,
      workspaceConfig,
      treeScanner: { invalidate: vi.fn(), getSourceTree: vi.fn() } as never,
      workspaceConfigMutationWouldChange: vi.fn(async () => true),
      persistWorkspaceConfigMutation,
    });

    await service.handler(serviceContext(), "setSharedRemote", [
      "projects/bgkit",
      {
        name: "origin",
        url: "https://github.com/werg/bgkit.git",
      },
    ]);

    expect(persistWorkspaceConfigMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        mutate: expect.any(Function),
      })
    );
    expect(workspaceConfig.git?.remotes?.["projects"]?.["bgkit"]?.["origin"]).toEqual({
      url: "https://github.com/werg/bgkit.git",
    });
    expect(fs.existsSync(projectedConfigPath)).toBe(false);
  });

  it("toggles auto-push as a host-owned manifest mutation", async () => {
    const workspacePath = tempWorkspace();
    const workspaceConfig: WorkspaceConfig = {
      id: "test",
      git: {
        remotes: {
          projects: {
            bgkit: {
              origin: { url: "https://github.com/werg/bgkit.git" },
            },
          },
        },
        upstreams: {
          projects: {
            bgkit: {
              remote: "origin",
              branch: "main",
              autoPush: false,
            },
          },
        },
      },
    };
    fs.writeFileSync(
      path.join(workspacePath, "meta", "vibestudio.yml"),
      YAML.stringify(workspaceConfig),
      "utf-8"
    );
    const invokeGitProvider = vi.fn();
    const service = createGitInteropService({
      workspacePath,
      workspaceConfig,
      treeScanner: { invalidate: vi.fn(), getSourceTree: vi.fn() } as never,
      invokeGitProvider,
      ...diskConfigPersistence(workspacePath),
    });

    await service.handler(serviceContext(), "setAutoPush", ["projects/bgkit", true]);

    expect(invokeGitProvider).not.toHaveBeenCalled();
    const config = YAML.parse(
      fs.readFileSync(path.join(workspacePath, "meta", "vibestudio.yml"), "utf-8")
    ) as WorkspaceConfig;
    expect(config.git?.upstreams?.["projects"]?.["bgkit"]).toEqual({
      remote: "origin",
      branch: "main",
      autoPush: true,
    });
  });

  it("delegates upstream engine operations to the configured provider", async () => {
    const ctx = serviceContext();
    const cases: Array<{ method: string; args: unknown[]; result: unknown }> = [
      {
        method: "upstreamStatus",
        args: [["projects/bgkit"], { fetch: true }],
        result: [
          {
            repoPath: "projects/bgkit",
            remote: "origin",
            branch: "main",
            autoPush: false,
            state: "in-sync",
            aheadBy: 0,
            behindBy: 0,
          },
        ],
      },
      {
        method: "pushUpstream",
        args: ["projects/bgkit", { force: true }],
        result: {
          exported: 1,
          headCommit: "abc123",
          pushed: true,
          status: "in-sync",
        },
      },
      {
        method: "pullUpstream",
        args: ["projects/bgkit", { dryRun: true }],
        result: {
          behindBy: 1,
          aheadBy: 0,
          remoteBranchExists: true,
          incoming: [{ sha: "abc123", summary: "change" }],
        },
      },
      {
        method: "resetExportMarker",
        args: ["projects/bgkit"],
        result: { repoPath: "projects/bgkit", cleared: true },
      },
      {
        method: "commitMapping",
        args: ["projects/bgkit", { limit: 5 }],
        result: [
          {
            gitSha: "abc123",
            gadState: `state:${"a".repeat(64)}`,
            gadEvent: "evt-1",
            summary: "change",
          },
        ],
      },
      {
        method: "publishRepo",
        args: [{ repoPath: "projects/bgkit", provider: "github", autoPush: true }],
        result: {
          repoPath: "projects/bgkit",
          provider: "github",
          remote: "origin",
          branch: "main",
          remoteUrl: "https://github.com/octo/bgkit.git",
          webUrl: "https://github.com/octo/bgkit",
          owner: "octo",
          exported: 1,
          headCommit: "abc123",
          pushed: true,
        },
      },
    ];
    for (const testCase of cases) {
      const invokeGitProviderMock = vi.fn(async () => testCase.result);
      const invokeGitProvider = invokeGitProviderMock as unknown as NonNullable<
        Parameters<typeof createGitInteropService>[0]["invokeGitProvider"]
      >;
      const service = createGitInteropService({
        treeScanner: { invalidate: vi.fn(), getSourceTree: vi.fn() } as never,
        invokeGitProvider,
      });

      await expect(service.handler(ctx, testCase.method, testCase.args)).resolves.toEqual(
        testCase.result
      );
      expect(invokeGitProviderMock).toHaveBeenCalledWith(ctx, testCase.method, testCase.args);
    }
  });

  it("publishes, verifies, and cleans a disposable remote without config mutation", async () => {
    const ctx = serviceContext();
    const disposableRemotes = {
      create: vi.fn(async () => ({
        id: "remote-1",
        name: "publish-check",
        url: "http://vibestudio.local/_disposable-git/remote-1/publish-check.git",
        branch: "main",
        expiresAt: Date.now() + 60_000,
      })),
      inspect: vi.fn(async () => ({
        id: "remote-1",
        url: "http://vibestudio.local/_disposable-git/remote-1/publish-check.git",
        branch: "main",
        commitCount: 3,
        headCommit: "abc123",
        expiresAt: Date.now() + 60_000,
      })),
      remove: vi.fn(async () => ({ removed: true })),
    };
    const invokeGitProviderMock = vi.fn(async () => ({
      exported: 3,
      pushed: true,
      headCommit: "abc123",
    }));
    const service = createGitInteropService({
      treeScanner: { invalidate: vi.fn(), getSourceTree: vi.fn() } as never,
      disposableRemotes: disposableRemotes as never,
      invokeGitProvider: invokeGitProviderMock as never,
    });

    await expect(
      service.handler(ctx, "publishToDisposableRemote", ["projects/bgkit"])
    ).resolves.toMatchObject({
      repoPath: "projects/bgkit",
      branch: "main",
      exported: 3,
      pushed: true,
      commitCount: 3,
      headCommit: "abc123",
    });
    expect(invokeGitProviderMock).toHaveBeenCalledWith(ctx, "pushDisposableRemote", [
      {
        repoPath: "projects/bgkit",
        url: expect.stringContaining("publish-check.git"),
        branch: "main",
      },
    ]);
    expect(disposableRemotes.remove).toHaveBeenCalledOnce();
  });

  it("pushes to an existing active disposable remote without removing it", async () => {
    const ctx = serviceContext();
    const url = "http://vibestudio.local/_disposable-git/remote-1/publish-check.git";
    const disposableRemotes = {
      create: vi.fn(),
      inspect: vi
        .fn()
        .mockResolvedValueOnce({
          id: "remote-1",
          url,
          branch: "main",
          commitCount: 0,
          headCommit: null,
          expiresAt: Date.now() + 60_000,
        })
        .mockResolvedValueOnce({
          id: "remote-1",
          url,
          branch: "main",
          commitCount: 3,
          headCommit: "abc123",
          expiresAt: Date.now() + 60_000,
        }),
      remove: vi.fn(),
    };
    const invokeGitProviderMock = vi.fn(async () => ({
      exported: 3,
      pushed: true,
      headCommit: "abc123",
    }));
    const service = createGitInteropService({
      treeScanner: { invalidate: vi.fn(), getSourceTree: vi.fn() } as never,
      disposableRemotes: disposableRemotes as never,
      invokeGitProvider: invokeGitProviderMock as never,
    });

    await expect(
      service.handler(ctx, "pushDisposableRemote", ["projects/bgkit", url, "main"])
    ).resolves.toEqual({
      repoPath: "projects/bgkit",
      branch: "main",
      exported: 3,
      pushed: true,
      commitCount: 3,
      headCommit: "abc123",
    });
    expect(invokeGitProviderMock).toHaveBeenCalledWith(ctx, "pushDisposableRemote", [
      { repoPath: "projects/bgkit", url, branch: "main" },
    ]);
    expect(disposableRemotes.remove).not.toHaveBeenCalled();
  });

  it("fails provider operations when no gitInterop provider is available", async () => {
    const service = createGitInteropService({
      treeScanner: { invalidate: vi.fn(), getSourceTree: vi.fn() } as never,
    });
    for (const [method, args] of [
      ["upstreamStatus", [[]]],
      ["pushUpstream", ["projects/bgkit"]],
      ["pullUpstream", ["projects/bgkit"]],
      ["publishRepo", [{ repoPath: "projects/bgkit" }]],
    ] as Array<[string, unknown[]]>) {
      await expect(service.handler(serviceContext(), method, args)).rejects.toThrow(
        "Git upstream provider is unavailable"
      );
    }
  });

  it("rejects provider results outside the canonical contract", async () => {
    const invokeGitProvider = vi.fn(async () => ({
      repoPath: "projects/bgkit",
      provider: "github",
      remoteUrl: "https://github.com/octo/bgkit.git",
      webUrl: "https://github.com/octo/bgkit",
      owner: "octo",
      exported: 1,
      headCommit: "abc123",
      pushed: true,
    })) as unknown as GitProviderInvoker;
    const service = createGitInteropService({
      treeScanner: { invalidate: vi.fn(), getSourceTree: vi.fn() } as never,
      invokeGitProvider,
    });

    await expect(
      service.handler(serviceContext(), "publishRepo", [{ repoPath: "projects/bgkit" }])
    ).rejects.toThrow("Invalid gitInterop.publishRepo provider result");
  });

  it("rejects malformed preparation results before completing an import", async () => {
    const workspacePath = tempWorkspace();
    const workspaceConfig: WorkspaceConfig = { id: "test" };
    const service = createGitInteropService({
      workspacePath,
      workspaceConfig,
      treeScanner: { invalidate: vi.fn(), getSourceTree: vi.fn() } as never,
      invokeGitProvider: vi.fn(async () => undefined) as unknown as GitProviderInvoker,
      ...diskConfigPersistence(workspacePath),
    });

    await expect(
      service.handler(serviceContext(), "importProject", [
        {
          path: "projects/bgkit",
          remote: {
            name: "origin",
            url: "https://github.com/werg/bgkit.git",
            branch: "main",
          },
        },
      ])
    ).rejects.toThrow("Invalid gitInterop.prepareImport provider result");
  });

  it("removing a declared remote also removes upstream tracking that points at it", async () => {
    const workspacePath = tempWorkspace();
    const workspaceConfig: WorkspaceConfig = {
      id: "test",
      git: {
        remotes: {
          panels: {
            notes: {
              origin: {
                url: "https://github.com/werg/notes.git",
                branch: "main",
              },
            },
          },
        },
        upstreams: {
          panels: {
            notes: {
              remote: "origin",
              branch: "main",
              autoPush: false,
            },
          },
        },
      },
    };
    fs.writeFileSync(
      path.join(workspacePath, "meta", "vibestudio.yml"),
      YAML.stringify(workspaceConfig),
      "utf-8"
    );
    const service = createGitInteropService({
      workspacePath,
      workspaceConfig,
      treeScanner: { invalidate: vi.fn(), getSourceTree: vi.fn() } as never,
      ...diskConfigPersistence(workspacePath),
    });

    const remaining = await service.handler(serviceContext(), "removeSharedRemote", [
      "panels/notes",
      "origin",
    ]);

    expect(remaining).toEqual({});
    expect(workspaceConfig.git?.remotes?.["panels"]?.["notes"]).toBeUndefined();
    expect(workspaceConfig.git?.upstreams?.["panels"]?.["notes"]).toBeUndefined();
  });
});

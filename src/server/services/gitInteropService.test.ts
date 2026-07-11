import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { createVerifiedCaller, type ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import type { WorkspaceConfig } from "@vibestudio/shared/workspace/types";
import type { ApprovalQueue } from "./approvalQueue.js";
import type { CapabilityGrantStore } from "./capabilityGrantStore.js";

import { createGitInteropService } from "./gitInteropService.js";

type GitProviderInvoker = NonNullable<
  Parameters<typeof createGitInteropService>[0]["invokeGitProvider"]
>;

function cloneProvider(
  cloneRepo: (ctx: ServiceContext, repoPath: string) => Promise<unknown>
): GitProviderInvoker {
  return (async (ctx: ServiceContext, method: string, args: unknown[]) => {
    if (method !== "cloneRepo") throw new Error(`Unexpected provider method: ${method}`);
    const input = args[0] as { repoPath: string };
    await cloneRepo(ctx, input.repoPath);
    return { stateHash: `state:${input.repoPath}`, changed: true };
  }) as GitProviderInvoker;
}

function tempWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-git-interop-"));
  fs.mkdirSync(path.join(root, "meta"), { recursive: true });
  return root;
}

function serviceContext(): ServiceContext {
  return {
    caller: createVerifiedCaller("server", "server"),
  } as ServiceContext;
}

function panelServiceContext(): ServiceContext {
  return {
    caller: createVerifiedCaller("panel-1", "panel", {
      callerId: "panel-1",
      callerKind: "panel",
      repoPath: "panels/test",
      effectiveVersion: "ev-panel",
    }),
  } as ServiceContext;
}

function grantStore(): CapabilityGrantStore {
  return {
    hasGrant: vi.fn(() => false),
    grant: vi.fn(),
  } as unknown as CapabilityGrantStore;
}

function diskConfigPersistence(workspacePath: string) {
  const configPath = path.join(workspacePath, "meta", "vibestudio.yml");
  const render = (nextConfig: WorkspaceConfig): string => {
    const before = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf-8") : "";
    const beforeParsed = before ? ((YAML.parse(before) as Record<string, unknown>) ?? {}) : {};
    return YAML.stringify({ ...beforeParsed, ...nextConfig });
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
  it("imports a requested branch and persists it as a shared remote", async () => {
    const workspacePath = tempWorkspace();
    const workspaceConfig: WorkspaceConfig = { id: "test" };
    const cloneRepo = vi.fn(async () => undefined);
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
      grantStore: grantStore(),
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
      grantStore: grantStore(),
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

  it("keeps the approved config declaration when extension clone fails", async () => {
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
      grantStore: grantStore(),
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
    ).rejects.toThrow("network unavailable");

    const config = YAML.parse(
      fs.readFileSync(path.join(workspacePath, "meta", "vibestudio.yml"), "utf-8")
    ) as WorkspaceConfig;
    expect(config.git?.remotes?.["projects"]?.["bgkit"]?.["origin"]).toEqual({
      url: "https://github.com/werg/bgkit.git",
      branch: "vibestudio-bridge",
    });
    expect(fs.existsSync(path.join(workspacePath, "projects", "bgkit"))).toBe(false);
    expect(sourceChanged).toHaveBeenCalledWith(
      panelServiceContext(),
      "Record Git remote for projects/bgkit"
    );
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
      grantStore: grantStore(),
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
            url: "https://github.com/werg/bgkit.git",
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
      panelServiceContext(),
      "Import workspace project projects/bgkit"
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
        result: { behindBy: 1, aheadBy: 0, incoming: [{ sha: "abc123", summary: "change" }] },
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

  it("rejects malformed clone results before completing an import", async () => {
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
          remote: { name: "origin", url: "https://github.com/werg/bgkit.git" },
        },
      ])
    ).rejects.toThrow("Invalid gitInterop.cloneRepo provider result");
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

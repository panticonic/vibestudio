import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { createVerifiedCaller, type ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import type { WorkspaceConfig } from "@vibestudio/workspace-contracts/types";
import { WORKSPACE_SYSTEM_EPOCH } from "@vibestudio/shared/vcs/systemEpoch";

import { createGitInteropService } from "./gitInteropService.js";

const BASE_WORKSPACE_CONFIG = { id: "test", systemEpoch: WORKSPACE_SYSTEM_EPOCH } as const;
const SEMANTIC_EVIDENCE = {
  applicationId: "application:import",
  workUnitId: "work-unit:import",
  externalSnapshot: {
    sourceKind: "git" as const,
    sourceUri: "https://github.com/example/project.git",
    snapshotRevision: "a".repeat(40),
    sourceSubdir: null,
    canonicalSnapshot: `v1-sha256:${"c".repeat(64)}`,
    snapshotDigest: `snapshot:${"b".repeat(64)}`,
    targetRepositoryIds: ["repository:import"],
  },
};

type GitProviderInvoker = NonNullable<
  Parameters<typeof createGitInteropService>[0]["invokeGitProvider"]
>;

function cloneProvider(
  cloneRepo: (ctx: ServiceContext, repoPath: string) => Promise<unknown>,
  materialization: "not-materialized" | "integration-required" = "not-materialized"
): GitProviderInvoker {
  return (async (ctx: ServiceContext, method: string, args: unknown[]) => {
    if (method === "upstreamStatus") {
      const paths = args[0] as string[];
      return paths.map((repoPath) => ({
        repoPath,
        autoPush: false,
        state: materialization,
        aheadBy: 0,
        behindBy: 0,
        ...(materialization === "integration-required"
          ? { candidate: { contextId: "git-bridge:candidate", eventId: "event:candidate" } }
          : {}),
      }));
    }
    if (method !== "cloneRepo") throw new Error(`Unexpected provider method: ${method}`);
    const input = args[0] as { repoPath: string };
    await cloneRepo(ctx, input.repoPath);
    return {
      contextId: `git-bridge:${input.repoPath}`,
      eventId: `event:${input.repoPath}`,
      changed: true,
      semanticEvidence: SEMANTIC_EVIDENCE,
    };
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
          ...BASE_WORKSPACE_CONFIG,
        })
      : BASE_WORKSPACE_CONFIG;
  return {
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
  it("prepares one exact, human-readable repository publication approval", () => {
    const service = createGitInteropService({});
    const prepare = service.authorityPreparation?.["gitInterop.publishRepo.destination"];
    const caller = createVerifiedCaller("panel-1", "panel", {
      callerId: "panel-1",
      callerKind: "panel",
      repoPath: "panels/test",
      effectiveVersion: "ev-panel",
      executionDigest: "a".repeat(64),
      requested: [
        {
          capability: "git.publish",
          resource: { kind: "prefix", prefix: "" },
        },
      ],
    });

    expect(
      prepare?.({ caller }, [
        {
          repoPath: "projects/default",
          provider: "github",
          name: "vibestudio-default-test",
          private: true,
          description: "Default project",
          branch: "main",
          autoPush: false,
        },
      ])
    ).toEqual({
      selections: [
        expect.objectContaining({
          capability: "git.publish",
          resourceKey: "external-repository:github:default:vibestudio-default-test",
          challenge: expect.objectContaining({
            title: "Create and publish vibestudio-default-test",
            resource: {
              type: "external-repository",
              label: "Destination",
              value: "GitHub / vibestudio-default-test",
            },
            substance: expect.objectContaining({
              summary: "Create a private GitHub repository and publish projects/default",
              facts: expect.arrayContaining([
                { label: "Visibility", value: "Private" },
                { label: "Publish", value: "projects/default → main" },
                { label: "Future changes", value: "Push only when requested" },
              ]),
            }),
          }),
        }),
      ],
      payload: null,
    });
  });

  it("prepares template contribution authority for one destination and protected-main event", () => {
    const service = createGitInteropService({});
    const prepare =
      service.authorityPreparation?.["gitInterop.pushTemplateContribution.destination"];
    const caller = createVerifiedCaller("template-composer", "extension", {
      callerId: "template-composer",
      callerKind: "extension",
      repoPath: "extensions/template-composer",
      effectiveVersion: "ev-template-composer",
      executionDigest: "b".repeat(64),
      requested: [
        {
          capability: "git.publish",
          resource: { kind: "prefix", prefix: "" },
        },
      ],
    });

    expect(
      prepare?.({ caller }, [
        {
          operationId: "suggest-1",
          nodeId: "t-abcdef",
          alias: "news",
          url: "https://github.com/acme/news.git",
          baseCommit: "a".repeat(40),
          expectedMainEventId: "event:main",
          credential: "github-main",
          parts: [
            { repoPath: "workers/news", subdir: "workers/news" },
            { repoPath: "panels/news", subdir: "panels/news" },
          ],
        },
      ])
    ).toEqual({
      selections: [
        expect.objectContaining({
          capability: "git.publish",
          resourceKey: expect.stringMatching(/^template-contribution:[0-9a-f]{64}$/u),
          challenge: expect.objectContaining({
            title: "Push a contribution to news",
            resource: {
              type: "external-repository",
              label: "Destination",
              value: "https://github.com/acme/news.git",
            },
            substance: {
              kind: "change-set",
              summary: "Publish 2 exact protected-main parts to news",
              facts: [
                { label: "Protected main", value: "event:main" },
                { label: "Template base", value: "a".repeat(40) },
                {
                  label: "Parts",
                  value: "panels/news → panels/news, workers/news → workers/news",
                },
              ],
            },
          }),
        }),
      ],
      payload: null,
    });
  });

  it("prepares template publication authority for the exact destination, event, and tree", () => {
    const service = createGitInteropService({});
    const prepare = service.authorityPreparation?.["gitInterop.publishTemplate.destination"];
    const caller = createVerifiedCaller("template-composer", "extension", {
      callerId: "template-composer",
      callerKind: "extension",
      repoPath: "extensions/template-composer",
      effectiveVersion: "ev-template-composer",
      executionDigest: "b".repeat(64),
      requested: [{ capability: "git.publish", resource: { kind: "prefix", prefix: "" } }],
    });
    const prepared = prepare?.({ caller }, [
      {
        operationId: "publish-news",
        expectedMainEventId: "event:main",
        templateName: "News",
        version: "1.0.0",
        manifest: "systemEpoch: 57\n",
        manifestDigest: `v1-sha256:${"a".repeat(64)}`,
        parts: [{ repoPath: "panels/news", subdir: "panels/news" }],
        destination: { provider: "github", owner: "acme", name: "template-news" },
        creation: { private: false },
      },
    ]);
    expect(prepared).toEqual({
      selections: [
        expect.objectContaining({
          capability: "git.publish",
          resourceKey: expect.stringMatching(/^template-publication:[0-9a-f]{64}$/u),
          challenge: expect.objectContaining({
            title: "Publish 1.0.0 to template-news",
            resource: {
              type: "external-repository",
              label: "Destination",
              value: "GitHub / acme/template-news",
            },
            substance: expect.objectContaining({
              summary: "Publish News 1.0.0 from exact protected main",
              facts: expect.arrayContaining([
                { label: "Protected main", value: "event:main" },
                { label: "Version", value: "1.0.0" },
                { label: "Manifest", value: `v1-sha256:${"a".repeat(64)}` },
              ]),
            }),
          }),
        }),
      ],
      payload: null,
    });
  });

  it("imports a requested branch and persists it as a shared remote", async () => {
    const workspacePath = tempWorkspace();
    const workspaceConfig: WorkspaceConfig = { ...BASE_WORKSPACE_CONFIG };
    const cloneRepo = vi.fn(async () => undefined);
    fs.writeFileSync(
      path.join(workspacePath, "meta", "vibestudio.yml"),
      YAML.stringify(BASE_WORKSPACE_CONFIG),
      "utf-8"
    );
    const service = createGitInteropService({
      workspacePath,
      workspaceConfig,
      invokeGitProvider: cloneProvider(cloneRepo),
      ...diskConfigPersistence(workspacePath),
    });

    const imported = await service.handler(serviceContext(), "importProject", [
      {
        path: "projects/bgkit",
        remote: {
          name: "origin",
          url: "https://github.com/werg/bgkit.git",
          branch: "vibestudio-bridge",
        },
        credentialIdOverride: null,
      },
    ]);

    expect(imported).toMatchObject({
      candidate: {
        contextId: "git-bridge:projects/bgkit",
        eventId: "event:projects/bgkit",
        changed: true,
      },
    });

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

  it("discovers and persists the remote default branch when the request omits it", async () => {
    const workspacePath = tempWorkspace();
    const workspaceConfig: WorkspaceConfig = { ...BASE_WORKSPACE_CONFIG };
    fs.writeFileSync(
      path.join(workspacePath, "meta", "vibestudio.yml"),
      YAML.stringify(BASE_WORKSPACE_CONFIG),
      "utf-8"
    );
    const invokeGitProvider = vi.fn(async (_ctx, method: string, args: unknown[]) => {
      if (method === "remoteDefaultBranch") return { branch: "trunk" };
      if (method === "cloneRepo") {
        const [{ repoPath }] = args as [{ repoPath: string }];
        return {
          contextId: `git-bridge:${repoPath}`,
          eventId: `event:${repoPath}`,
          changed: true,
          semanticEvidence: SEMANTIC_EVIDENCE,
        };
      }
      throw new Error(`Unexpected provider method: ${method}`);
    }) as unknown as GitProviderInvoker;
    const service = createGitInteropService({
      workspacePath,
      workspaceConfig,
      invokeGitProvider,
      ...diskConfigPersistence(workspacePath),
    });

    await service.handler(serviceContext(), "importProject", [
      {
        path: "projects/bgkit",
        remote: {
          name: "origin",
          url: "https://github.com/werg/bgkit.git",
        },
      },
    ]);

    expect(invokeGitProvider).toHaveBeenNthCalledWith(1, expect.anything(), "remoteDefaultBranch", [
      { url: "https://github.com/werg/bgkit.git" },
    ]);
    expect(invokeGitProvider).toHaveBeenNthCalledWith(2, expect.anything(), "cloneRepo", [
      { repoPath: "projects/bgkit" },
    ]);
    expect(workspaceConfig.git?.remotes?.["projects"]?.["bgkit"]?.["origin"]?.branch).toBe("trunk");
    expect(workspaceConfig.git?.upstreams?.["projects"]?.["bgkit"]?.branch).toBe("trunk");
  });

  it("fails closed when an omitted branch cannot be discovered", async () => {
    const workspacePath = tempWorkspace();
    const workspaceConfig: WorkspaceConfig = { ...BASE_WORKSPACE_CONFIG };
    fs.writeFileSync(
      path.join(workspacePath, "meta", "vibestudio.yml"),
      YAML.stringify(BASE_WORKSPACE_CONFIG),
      "utf-8"
    );
    const invokeGitProvider = vi.fn(async () => {
      throw new Error("remote unavailable");
    }) as unknown as GitProviderInvoker;
    const service = createGitInteropService({
      workspacePath,
      workspaceConfig,
      invokeGitProvider,
      ...diskConfigPersistence(workspacePath),
    });

    await expect(
      service.handler(serviceContext(), "importProject", [
        {
          path: "projects/bgkit",
          remote: {
            name: "origin",
            url: "https://github.com/werg/bgkit.git",
          },
        },
      ])
    ).rejects.toThrow("remote unavailable");
    expect(workspaceConfig.git).toBeUndefined();
  });

  it("requires an explicit branch when the remote has no symbolic default", async () => {
    const workspacePath = tempWorkspace();
    const workspaceConfig: WorkspaceConfig = { ...BASE_WORKSPACE_CONFIG };
    fs.writeFileSync(
      path.join(workspacePath, "meta", "vibestudio.yml"),
      YAML.stringify(BASE_WORKSPACE_CONFIG),
      "utf-8"
    );
    const invokeGitProvider = vi.fn(async () => ({
      branch: null,
    })) as unknown as GitProviderInvoker;
    const service = createGitInteropService({
      workspacePath,
      workspaceConfig,
      invokeGitProvider,
      ...diskConfigPersistence(workspacePath),
    });

    await expect(
      service.handler(serviceContext(), "importProject", [
        {
          path: "projects/bgkit",
          remote: {
            name: "origin",
            url: "https://github.com/werg/bgkit.git",
          },
        },
      ])
    ).rejects.toThrow("specify remote.branch explicitly");
    expect(workspaceConfig.git).toBeUndefined();
  });

  it("reuses an exact declaration without rewriting repository-specific settings", async () => {
    const workspacePath = tempWorkspace();
    const workspaceConfig: WorkspaceConfig = {
      ...BASE_WORKSPACE_CONFIG,
      git: {
        remotes: {
          projects: {
            bgkit: {
              origin: {
                url: "https://github.com/werg/bgkit.git",
                branch: "release",
              },
              mirror: {
                url: "https://example.test/bgkit-mirror.git",
                branch: "release",
              },
            },
          },
        },
        upstreams: {
          projects: {
            bgkit: {
              remote: "origin",
              branch: "release",
              autoPush: true,
              credential: "github-main",
              authorEmail: "automation@example.com",
              authorName: "Workspace Automation",
            },
          },
        },
      },
    };
    const cloneRepo = vi.fn(async () => undefined);
    const persistWorkspaceConfigMutation = vi.fn();
    const service = createGitInteropService({
      workspacePath,
      workspaceConfig,
      invokeGitProvider: cloneProvider(cloneRepo),
      persistWorkspaceConfigMutation,
    });

    await expect(
      service.handler(panelServiceContext(), "importProject", [
        {
          path: "projects/bgkit",
          remote: {
            name: "origin",
            url: "https://github.com/werg/bgkit.git",
            branch: "release",
          },
        },
      ])
    ).resolves.toMatchObject({
      path: "projects/bgkit",
      remote: {
        name: "origin",
        url: "https://github.com/werg/bgkit.git",
        branch: "release",
      },
      candidate: { changed: true },
    });

    expect(cloneRepo).toHaveBeenCalledOnce();
    expect(persistWorkspaceConfigMutation).not.toHaveBeenCalled();
    expect(workspaceConfig.git?.upstreams?.["projects"]?.["bgkit"]).toMatchObject({
      autoPush: true,
      credential: "github-main",
      authorEmail: "automation@example.com",
      authorName: "Workspace Automation",
    });
    expect(workspaceConfig.git?.remotes?.["projects"]?.["bgkit"]?.["mirror"]).toBeDefined();
  });

  it("publishes the protected config mutation before cloning an imported project", async () => {
    const workspacePath = tempWorkspace();
    const workspaceConfig: WorkspaceConfig = { ...BASE_WORKSPACE_CONFIG };
    const cloneRepo = vi.fn(async () => undefined);
    fs.writeFileSync(
      path.join(workspacePath, "meta", "vibestudio.yml"),
      YAML.stringify(BASE_WORKSPACE_CONFIG),
      "utf-8"
    );
    const persistence = diskConfigPersistence(workspacePath);
    const service = createGitInteropService({
      workspacePath,
      workspaceConfig,
      invokeGitProvider: cloneProvider(cloneRepo),
      ...persistence,
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

    expect(persistence.persistWorkspaceConfigMutation).toHaveBeenCalledTimes(1);
    expect(persistence.persistWorkspaceConfigMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        summary:
          "meta/vibestudio.yml records origin=github.com/werg/bgkit.git for projects/bgkit on vibestudio-bridge",
      })
    );
    expect(persistence.persistWorkspaceConfigMutation.mock.invocationCallOrder[0]).toBeLessThan(
      cloneRepo.mock.invocationCallOrder[0]!
    );
  });

  it("does not clone when the protected config publication is denied", async () => {
    const workspacePath = tempWorkspace();
    const workspaceConfig: WorkspaceConfig = { ...BASE_WORKSPACE_CONFIG };
    const cloneRepo = vi.fn(async () => undefined);
    fs.writeFileSync(
      path.join(workspacePath, "meta", "vibestudio.yml"),
      YAML.stringify(BASE_WORKSPACE_CONFIG),
      "utf-8"
    );
    const service = createGitInteropService({
      workspacePath,
      workspaceConfig,
      invokeGitProvider: cloneProvider(cloneRepo),
      persistWorkspaceConfigMutation: vi.fn(async () => {
        throw new Error("Protected workspace update denied");
      }),
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
    ).rejects.toThrow("Protected workspace update denied");

    expect(cloneRepo).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(workspacePath, "projects", "bgkit"))).toBe(false);
  });

  it("rolls the approved config declaration back when extension clone fails", async () => {
    const workspacePath = tempWorkspace();
    const workspaceConfig: WorkspaceConfig = { ...BASE_WORKSPACE_CONFIG };
    const cloneRepo = vi.fn().mockRejectedValueOnce(new Error("network unavailable"));
    fs.writeFileSync(
      path.join(workspacePath, "meta", "vibestudio.yml"),
      YAML.stringify(BASE_WORKSPACE_CONFIG),
      "utf-8"
    );
    const service = createGitInteropService({
      workspacePath,
      workspaceConfig,
      invokeGitProvider: cloneProvider(cloneRepo),
      ...diskConfigPersistence(workspacePath),
    });

    const rejected = await service
      .handler(panelServiceContext(), "importProject", [
        {
          path: "projects/bgkit",
          remote: {
            name: "origin",
            url: "https://github.com/werg/bgkit.git",
            branch: "vibestudio-bridge",
          },
        },
      ])
      .catch((error: unknown) => error);

    expect(rejected).toMatchObject({
      message: expect.stringMatching(
        /failed during clone: network unavailable.*declaration was restored.*re-running the import/s
      ),
      errorData: {
        operation: "git.importProject",
        repoPath: "projects/bgkit",
        stage: "clone",
        primary: { message: "network unavailable" },
        config: { changed: true, rolledBack: true },
      },
    });

    // No phantom declaration survives a failed clone: the remote/upstream
    // config is rolled back and the retry path is a clean re-import.
    const config = YAML.parse(
      fs.readFileSync(path.join(workspacePath, "meta", "vibestudio.yml"), "utf-8")
    ) as WorkspaceConfig;
    expect(config.git?.remotes?.["projects"]?.["bgkit"]?.["origin"]).toBeUndefined();
    expect(config.git?.upstreams?.["projects"]?.["bgkit"]).toBeUndefined();
    expect(fs.existsSync(path.join(workspacePath, "projects", "bgkit"))).toBe(false);
  });

  it("rejects a conflicting re-import without rewriting the existing declaration", async () => {
    const workspacePath = tempWorkspace();
    const workspaceConfig: WorkspaceConfig = {
      ...BASE_WORKSPACE_CONFIG,
      git: {
        remotes: {
          projects: {
            bgkit: {
              origin: {
                url: "https://github.com/werg/original.git",
                branch: "release",
              },
            },
          },
        },
        upstreams: {
          projects: {
            bgkit: {
              remote: "origin",
              branch: "release",
              autoPush: true,
              credential: "github-original",
              authorEmail: "automation@example.com",
              authorName: "Workspace Automation",
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
    const originalGit = structuredClone(workspaceConfig.git);
    const service = createGitInteropService({
      workspacePath,
      workspaceConfig,
      invokeGitProvider: cloneProvider(
        vi.fn().mockRejectedValueOnce(new Error("network unavailable"))
      ),
      ...diskConfigPersistence(workspacePath),
    });

    await expect(
      service.handler(panelServiceContext(), "importProject", [
        {
          path: "projects/bgkit",
          remote: {
            name: "origin",
            url: "https://github.com/werg/replacement.git",
            branch: "next",
          },
          credentialIdOverride: "github-replacement",
        },
      ])
    ).rejects.toThrow(
      /conflicts with meta\/vibestudio\.yml: remote origin URL.*upstream branch.*Edit the remote\/upstream declaration explicitly/s
    );

    const persistedConfig = YAML.parse(
      fs.readFileSync(path.join(workspacePath, "meta", "vibestudio.yml"), "utf-8")
    ) as WorkspaceConfig;
    expect(persistedConfig.git).toEqual(originalGit);
  });

  it("rejects a conflicting declaration before clone or config persistence", async () => {
    const workspacePath = tempWorkspace();
    const workspaceConfig: WorkspaceConfig = {
      ...BASE_WORKSPACE_CONFIG,
      git: {
        remotes: {
          projects: {
            bgkit: {
              origin: {
                url: "https://github.com/werg/original.git",
                branch: "release",
              },
            },
          },
        },
        upstreams: {
          projects: {
            bgkit: {
              remote: "origin",
              branch: "release",
              autoPush: false,
              credential: "github-original",
            },
          },
        },
      },
    };
    let currentConfig = structuredClone(workspaceConfig);
    const concurrentConfig: WorkspaceConfig = {
      ...workspaceConfig,
      git: {
        remotes: {
          projects: {
            bgkit: {
              origin: {
                url: "https://github.com/werg/concurrent.git",
                branch: "developer-branch",
              },
            },
          },
        },
        upstreams: {
          projects: {
            bgkit: {
              remote: "origin",
              branch: "developer-branch",
              autoPush: true,
              credential: "github-developer",
              authorName: "Concurrent Developer",
            },
          },
        },
      },
    };
    const persistWorkspaceConfigMutation = vi.fn(
      async ({ mutate }: { mutate: (current: WorkspaceConfig) => WorkspaceConfig }) => {
        const previous = currentConfig;
        const nextConfig = mutate(previous);
        currentConfig = nextConfig;
        return {
          changed: JSON.stringify(nextConfig) !== JSON.stringify(previous),
          nextConfig,
        };
      }
    );
    const cloneRepo = vi.fn(async () => {
      currentConfig = structuredClone(concurrentConfig);
      throw new Error("network unavailable");
    });
    const service = createGitInteropService({
      workspacePath,
      workspaceConfig,
      invokeGitProvider: cloneProvider(cloneRepo),
      persistWorkspaceConfigMutation,
    });

    const rejected = await service
      .handler(panelServiceContext(), "importProject", [
        {
          path: "projects/bgkit",
          remote: {
            name: "origin",
            url: "https://github.com/werg/replacement.git",
            branch: "next",
          },
          credentialIdOverride: "github-replacement",
        },
      ])
      .catch((error: unknown) => error);

    expect(rejected).toBeInstanceOf(Error);
    expect((rejected as Error).message).toMatch(/conflicts with meta\/vibestudio\.yml/);
    expect(currentConfig.git).toEqual(workspaceConfig.git);
    expect(cloneRepo).not.toHaveBeenCalled();
    expect(persistWorkspaceConfigMutation).not.toHaveBeenCalled();
  });

  it("keeps clone failure primary and attaches a failed rollback as secondary data", async () => {
    const workspacePath = tempWorkspace();
    const workspaceConfig: WorkspaceConfig = { ...BASE_WORKSPACE_CONFIG };
    const cloneFailure = Object.assign(new Error("network unavailable"), {
      code: "ENETDOWN",
      errorKind: "transport",
      errorData: { requestStage: "smart-http" },
    });
    const rollbackFailure = Object.assign(new Error("rollback cleanup failed"), {
      code: "EACCES",
      errorKind: "access",
      errorData: {
        cleanupFailures: [{ stage: "drop-temporary-context", message: "context cleanup failed" }],
      },
    });
    const persistWorkspaceConfigMutation = vi
      .fn()
      .mockImplementationOnce(
        async ({ mutate }: { mutate: (current: WorkspaceConfig) => WorkspaceConfig }) => ({
          changed: true,
          nextConfig: mutate(workspaceConfig),
        })
      )
      .mockRejectedValueOnce(rollbackFailure);
    const service = createGitInteropService({
      workspacePath,
      workspaceConfig,
      invokeGitProvider: cloneProvider(vi.fn().mockRejectedValueOnce(cloneFailure)),
      persistWorkspaceConfigMutation,
    });

    const rejected = await service
      .handler(panelServiceContext(), "importProject", [
        {
          path: "projects/bgkit",
          remote: {
            name: "origin",
            url: "https://github.com/werg/bgkit.git",
            branch: "main",
          },
        },
      ])
      .catch((error: unknown) => error);

    expect(rejected).toMatchObject({
      message: expect.stringMatching(/^Import of projects\/bgkit failed during clone:/),
      cause: cloneFailure,
      errorData: {
        operation: "git.importProject",
        repoPath: "projects/bgkit",
        stage: "clone",
        primary: {
          message: "network unavailable",
          code: "ENETDOWN",
          errorKind: "transport",
          errorData: { requestStage: "smart-http" },
        },
        config: {
          changed: true,
          rolledBack: false,
          rollbackFailure: {
            message: "rollback cleanup failed",
            code: "EACCES",
            errorKind: "access",
            errorData: {
              cleanupFailures: [
                { stage: "drop-temporary-context", message: "context cleanup failed" },
              ],
            },
          },
        },
      },
    });
  });

  it("uses the injected config writer instead of reading the projected meta file", async () => {
    const workspacePath = tempWorkspace();
    const projectedConfigPath = path.join(workspacePath, "meta", "vibestudio.yml");
    fs.rmSync(projectedConfigPath, { force: true });
    const workspaceConfig: WorkspaceConfig = { ...BASE_WORKSPACE_CONFIG };
    const persistWorkspaceConfigMutation = vi.fn(
      async ({ mutate }: { mutate: (current: WorkspaceConfig) => WorkspaceConfig }) => ({
        changed: true,
        nextConfig: mutate(workspaceConfig),
      })
    );
    const service = createGitInteropService({
      workspacePath,
      workspaceConfig,
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
      ...BASE_WORKSPACE_CONFIG,
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
    const requestGitReconciliation = vi.fn();
    const service = createGitInteropService({
      workspacePath,
      workspaceConfig,
      invokeGitProvider,
      requestGitReconciliation,
      ...diskConfigPersistence(workspacePath),
    });

    await service.handler(serviceContext(), "setAutoPush", ["projects/bgkit", true]);

    expect(invokeGitProvider).not.toHaveBeenCalled();
    expect(requestGitReconciliation).toHaveBeenCalledWith(["projects/bgkit"]);
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
        args: [["projects/bgkit"]],
        result: [
          {
            repoPath: "projects/bgkit",
            remote: "origin",
            branch: "main",
            autoPush: false,
            state: "in-sync",
            relationship: "in-sync",
            aheadBy: 0,
            behindBy: 0,
            remoteBranchExists: true,
            observedAt: 1,
          },
        ],
      },
      {
        method: "pushUpstream",
        args: ["projects/bgkit", { force: true }],
        result: {
          exported: 1,
          headCommit: "abc123",
          outcome: "pushed",
        },
      },
      {
        method: "pullUpstream",
        args: ["projects/bgkit", { dryRun: true }],
        result: {
          remote: "origin",
          branch: "main",
          observedCommit: "abc123",
          changed: false,
          behindBy: 1,
          aheadBy: 0,
          remoteBranchExists: true,
          incoming: [{ sha: "abc123", summary: "change" }],
        },
      },
      {
        method: "commitMapping",
        args: ["projects/bgkit", { limit: 5 }],
        result: [
          {
            gitSha: "abc123",
            eventId: "event:1",
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
      {
        method: "pushTemplateContribution",
        args: [
          {
            operationId: "template-suggest-1",
            nodeId: "t-abcdef",
            alias: "news",
            url: "https://github.com/acme/news.git",
            baseCommit: "a".repeat(40),
            expectedMainEventId: "event:main",
            parts: [{ repoPath: "panels/news", subdir: "panels/news" }],
          },
        ],
        result: {
          outcome: "pushed",
          operationId: "template-suggest-1",
          branch: "vibestudio/workspace/request",
          headCommit: "b".repeat(40),
          commits: 1,
          parts: ["panels/news"],
        },
      },
    ];
    for (const testCase of cases) {
      const invokeGitProviderMock = vi.fn(async () => testCase.result);
      const invokeGitProvider = invokeGitProviderMock as unknown as NonNullable<
        Parameters<typeof createGitInteropService>[0]["invokeGitProvider"]
      >;
      const service = createGitInteropService({
        invokeGitProvider,
      });

      await expect(service.handler(ctx, testCase.method, testCase.args)).resolves.toEqual(
        testCase.result
      );
      expect(invokeGitProviderMock).toHaveBeenCalledWith(ctx, testCase.method, testCase.args);
    }
  });

  it("resolves a logical workspace credential at the host boundary without persisting its id", async () => {
    const workspaceConfig: WorkspaceConfig = {
      ...BASE_WORKSPACE_CONFIG,
      git: {
        remotes: {
          projects: {
            bgkit: {
              origin: { url: "https://github.com/werg/bgkit.git", branch: "main" },
            },
          },
        },
        upstreams: {
          projects: {
            bgkit: {
              remote: "origin",
              branch: "main",
              autoPush: false,
              credential: "github-main",
            },
          },
        },
      },
    };
    const resolveCredential = vi.fn(() => "credential-concrete");
    const invokeGitProvider = vi.fn(async () => ({
      exported: 1,
      headCommit: "abc123",
      outcome: "pushed" as const,
    }));
    const service = createGitInteropService({
      workspaceId: "workspace-1",
      workspaceConfig,
      resolveCredential,
      invokeGitProvider: invokeGitProvider as NonNullable<
        Parameters<typeof createGitInteropService>[0]["invokeGitProvider"]
      >,
    });

    await service.handler(serviceContext(), "pushUpstream", ["projects/bgkit"]);

    expect(resolveCredential).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      name: "github-main",
      url: "https://github.com/werg/bgkit.git",
    });
    expect(invokeGitProvider).toHaveBeenCalledWith(expect.anything(), "pushUpstream", [
      "projects/bgkit",
      { credentialIdOverride: "credential-concrete" },
    ]);
    expect(workspaceConfig.git?.upstreams?.["projects"]?.["bgkit"]).toEqual(
      expect.objectContaining({ credential: "github-main" })
    );
  });

  it("fails provider operations when no gitInterop provider is available", async () => {
    const service = createGitInteropService({});
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
      invokeGitProvider,
    });

    await expect(
      service.handler(serviceContext(), "publishRepo", [{ repoPath: "projects/bgkit" }])
    ).rejects.toThrow("Invalid gitInterop.publishRepo provider result");
  });

  it("rejects malformed clone results before completing an import", async () => {
    const workspacePath = tempWorkspace();
    const workspaceConfig: WorkspaceConfig = { ...BASE_WORKSPACE_CONFIG };
    const service = createGitInteropService({
      workspacePath,
      workspaceConfig,
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
    ).rejects.toThrow("Invalid gitInterop.cloneRepo provider result");
  });

  it("removing a declared remote also removes upstream tracking that points at it", async () => {
    const workspacePath = tempWorkspace();
    const workspaceConfig: WorkspaceConfig = {
      ...BASE_WORKSPACE_CONFIG,
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

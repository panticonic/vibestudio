import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import YAML from "yaml";
import { createVerifiedCaller, type ServiceContext } from "@natstack/shared/serviceDispatcher";
import type { WorkspaceConfig } from "@natstack/shared/workspace/types";
import type { ApprovalQueue } from "./approvalQueue.js";
import type { CapabilityGrantStore } from "./capabilityGrantStore.js";

const gitMocks = vi.hoisted(() => ({
  clone: vi.fn(async () => undefined),
}));

vi.mock("@natstack/git", () => ({
  GitClient: vi.fn().mockImplementation(() => ({
    clone: gitMocks.clone,
  })),
}));

import { createGitInteropService } from "./gitInteropService.js";

function tempWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-git-interop-"));
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

describe("gitInteropService", () => {
  it("imports a requested branch and persists it as a shared remote", async () => {
    gitMocks.clone.mockClear();
    const workspacePath = tempWorkspace();
    const workspaceConfig: WorkspaceConfig = { id: "test" };
    fs.writeFileSync(
      path.join(workspacePath, "meta", "natstack.yml"),
      YAML.stringify({ id: "test" }),
      "utf-8"
    );
    const service = createGitInteropService({
      workspacePath,
      workspaceConfig,
      treeScanner: { invalidate: vi.fn(), getSourceTree: vi.fn() } as never,
      egressProxy: { forwardGitHttp: vi.fn() },
    });

    await service.handler(serviceContext(), "importProject", [
      {
        path: "projects/bgkit",
        remote: {
          name: "origin",
          url: "https://github.com/werg/bgkit.git",
        },
        branch: "natstack-bridge",
      },
    ]);

    expect(gitMocks.clone).toHaveBeenCalledWith({
      url: "https://github.com/werg/bgkit.git",
      dir: path.join(workspacePath, "projects", "bgkit"),
      ref: "natstack-bridge",
    });
    const config = YAML.parse(
      fs.readFileSync(path.join(workspacePath, "meta", "natstack.yml"), "utf-8")
    ) as WorkspaceConfig;
    expect(config.git?.remotes?.["projects"]?.["bgkit"]?.["origin"]).toEqual({
      url: "https://github.com/werg/bgkit.git",
      branch: "natstack-bridge",
    });
  });

  it("uses one config-write approval before importing a project that edits natstack.yml", async () => {
    gitMocks.clone.mockClear();
    const workspacePath = tempWorkspace();
    const workspaceConfig: WorkspaceConfig = { id: "test" };
    fs.writeFileSync(
      path.join(workspacePath, "meta", "natstack.yml"),
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
      egressProxy: { forwardGitHttp: vi.fn() },
      approvalQueue,
      grantStore: grantStore(),
    });

    await service.handler(panelServiceContext(), "importProject", [
      {
        path: "projects/bgkit",
        remote: {
          name: "origin",
          url: "https://github.com/werg/bgkit.git",
        },
        branch: "natstack-bridge",
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
            "meta/natstack.yml records origin=github.com/werg/bgkit.git for projects/bgkit on natstack-bridge",
        },
      })
    );
  });

  it("does not clone when config-write approval is denied", async () => {
    gitMocks.clone.mockClear();
    const workspacePath = tempWorkspace();
    const workspaceConfig: WorkspaceConfig = { id: "test" };
    fs.writeFileSync(
      path.join(workspacePath, "meta", "natstack.yml"),
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
      egressProxy: { forwardGitHttp: vi.fn() },
      approvalQueue,
      grantStore: grantStore(),
    });

    await expect(
      service.handler(panelServiceContext(), "importProject", [
        {
          path: "projects/bgkit",
          remote: {
            name: "origin",
            url: "https://github.com/werg/bgkit.git",
          },
          branch: "natstack-bridge",
        },
      ])
    ).rejects.toThrow("Workspace config edit denied");

    expect(gitMocks.clone).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(workspacePath, "projects", "bgkit"))).toBe(false);
  });

  it("keeps the approved config declaration when the clone fails", async () => {
    gitMocks.clone.mockClear();
    gitMocks.clone.mockRejectedValueOnce(new Error("network unavailable"));
    const workspacePath = tempWorkspace();
    const workspaceConfig: WorkspaceConfig = { id: "test" };
    const sourceChanged = vi.fn(async () => undefined);
    fs.writeFileSync(
      path.join(workspacePath, "meta", "natstack.yml"),
      YAML.stringify({ id: "test" }),
      "utf-8"
    );
    const service = createGitInteropService({
      workspacePath,
      workspaceConfig,
      treeScanner: { invalidate: vi.fn(), getSourceTree: vi.fn() } as never,
      egressProxy: { forwardGitHttp: vi.fn() },
      approvalQueue: {
        request: vi.fn(async () => "once" as const),
      } as unknown as ApprovalQueue,
      grantStore: grantStore(),
      onWorkspaceSourceChanged: sourceChanged,
    });

    await expect(
      service.handler(panelServiceContext(), "importProject", [
        {
          path: "projects/bgkit",
          remote: {
            name: "origin",
            url: "https://github.com/werg/bgkit.git",
          },
          branch: "natstack-bridge",
        },
      ])
    ).rejects.toThrow("network unavailable");

    const config = YAML.parse(
      fs.readFileSync(path.join(workspacePath, "meta", "natstack.yml"), "utf-8")
    ) as WorkspaceConfig;
    expect(config.git?.remotes?.["projects"]?.["bgkit"]?.["origin"]).toEqual({
      url: "https://github.com/werg/bgkit.git",
      branch: "natstack-bridge",
    });
    expect(fs.existsSync(path.join(workspacePath, "projects", "bgkit"))).toBe(false);
    expect(sourceChanged).toHaveBeenCalledWith(
      panelServiceContext(),
      "Record Git remote for projects/bgkit"
    );
  });

  it("imports configured workspace dependencies without prompting for another approval", async () => {
    gitMocks.clone.mockClear();
    const workspacePath = tempWorkspace();
    const workspaceConfig: WorkspaceConfig = {
      id: "test",
      git: {
        remotes: {
          projects: {
            bgkit: {
              origin: {
                url: "https://github.com/werg/bgkit.git",
                branch: "natstack-bridge",
              },
            },
          },
        },
      },
    };
    const sourceChanged = vi.fn(async () => undefined);
    fs.writeFileSync(
      path.join(workspacePath, "meta", "natstack.yml"),
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
      egressProxy: { forwardGitHttp: vi.fn() },
      approvalQueue,
      grantStore: grantStore(),
      onWorkspaceSourceChanged: sourceChanged,
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
            branch: "natstack-bridge",
          },
        },
      ],
      skipped: [],
      failed: [],
    });
    expect(approvalQueue.request).not.toHaveBeenCalled();
    expect(gitMocks.clone).toHaveBeenCalledWith({
      url: "https://github.com/werg/bgkit.git",
      dir: path.join(workspacePath, "projects", "bgkit"),
      ref: "natstack-bridge",
    });
    expect(sourceChanged).toHaveBeenCalledWith(
      panelServiceContext(),
      "Import workspace project projects/bgkit"
    );
  });
});

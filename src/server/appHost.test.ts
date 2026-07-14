import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { writeProductSeedSourceRecord } from "@vibestudio/shared/productSeedTrust";
import { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import { sha256 } from "@vibestudio/shared/execution/identity";
import type { PendingApproval } from "@vibestudio/shared/approvals";
import { AppHost } from "./appHost.js";
import { executionArtifactFixture } from "./testing/executionArtifactFixture.js";
import { ServerUnitApprovalCoordinator } from "./unitApprovalCoordinator.js";

const roots: string[] = [];
const originalAppDevStatus = process.env["VIBESTUDIO_APP_DEV_STATUS"];
const REACT_NATIVE_PROVIDER = {
  name: "@workspace-extensions/react-native",
  activeSourceDigest: "sourceDigest-provider",
  activeBuildKey: "provider-build",
  contractVersion: "vibestudio-build-provider-v1",
};
const APP_SOURCE = sha256("app-source-v1");
const APP_SOURCE_2 = sha256("app-source-v2");
const testAuthority = (capabilities: readonly string[] = []) => ({
  requests: capabilities.map((capability) => ({
    capability,
    resource: { kind: "prefix" as const, prefix: "" },
  })),
});
const TEST_APP_EXECUTION = executionArtifactFixture(
  "apps/shell",
  {
    dir: "/test/app-key",
    metadata: { sourceDigest: APP_SOURCE, kind: "app", name: "@workspace-apps/shell" },
    artifacts: [
      {
        path: "index.html",
        role: "html",
        contentType: "text/html; charset=utf-8",
        encoding: "utf8",
        content: "<!doctype html><div>app</div>",
      },
    ],
  } as never,
  "main",
  "app-key"
);

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  if (originalAppDevStatus === undefined) delete process.env["VIBESTUDIO_APP_DEV_STATUS"];
  else process.env["VIBESTUDIO_APP_DEV_STATUS"] = originalAppDevStatus;
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-app-host-"));
  roots.push(root);
  return root;
}

function makeHarness(
  opts: {
    seeded?: boolean;
    invalidManifest?: boolean;
    approvalDecision?: "once" | "session" | "version" | "deny";
    useApprovalCoordinator?: boolean;
    readWorkspaceFileAtCommit?: (commit: string, filePath: string) => Promise<string | null>;
    reactNativeAppArtifactBaseUrl?: string;
    terminalAppArtifactBaseUrl?: string;
  } = {}
) {
  const root = tempRoot();
  const workspacePath = path.join(root, "source");
  const appPath = path.join(workspacePath, "apps", "shell");
  fs.mkdirSync(path.join(workspacePath, "meta"), { recursive: true });
  fs.mkdirSync(appPath, { recursive: true });
  fs.writeFileSync(
    path.join(appPath, "package.json"),
    JSON.stringify({
      name: "@workspace-apps/shell",
      version: "1.0.0",
      vibestudio: {
        displayName: "Shell App",
        app: {
          target: "electron",
          renderer: "index.tsx",
          capabilities: ["notifications"],
          ...(opts.invalidManifest ? { preload: "preload.ts" } : {}),
        },
        authority: testAuthority(["notifications", "panel-hosting"]),
      },
    })
  );
  fs.writeFileSync(path.join(appPath, "index.tsx"), "export default null;\n");
  if (opts.seeded) {
    writeProductSeedSourceRecord({
      unitDir: appPath,
      unitKind: "app",
      name: "@workspace-apps/shell",
      sourceRepo: "apps/shell",
    });
  }
  const artifact = {
    path: "index.html",
    role: "html",
    contentType: "text/html; charset=utf-8",
    encoding: "utf8",
    content: "<!doctype html><div>app</div>",
  } as const;
  const graphNode = {
    name: "@workspace-apps/shell",
    kind: "app",
    relativePath: "apps/shell",
    path: appPath,
    internalDeps: [],
    manifest: {
      displayName: "Shell App",
      app: { target: "electron" as const, capabilities: ["notifications" as const] },
      authority: testAuthority(["notifications", "panel-hosting"]),
    },
  };
  const providerChangeCallbacks: Array<
    (event: {
      type: "registered" | "unregistered";
      target: "react-native";
      provider: {
        name: string;
        activeSourceDigest: string | null;
        activeBuildKey: string | null;
        contractVersion: string;
      };
    }) => void
  > = [];
  const appBuild = {
    dir: path.join(root, "state", "builds", "app-key"),
    metadata: {
      sourceDigest: APP_SOURCE,
      sourceStateHash: "state:test",
      details: { kind: "app", target: "electron", integrity: "sha256-app" },
    },
    artifacts: [artifact],
  };
  const exact = TEST_APP_EXECUTION;
  const compilationRecords = new Map<string, typeof appBuild>([["app-key", appBuild]]);
  const executionBundles = new Map<string, typeof exact.bundle>([
    [exact.binding.artifact.executionDigest, exact.bundle],
  ]);
  const getBuild = vi.fn(async (_unitPath?: string, _ref?: string) => appBuild);
  const registerExecution = (build: typeof appBuild, ref = "main") => {
    const key = path.basename(build.dir);
    const resolved = executionArtifactFixture(graphNode.relativePath, build as never, ref, key);
    compilationRecords.set(key, build);
    executionBundles.set(resolved.binding.artifact.executionDigest, resolved.bundle);
    return resolved;
  };
  const resolveExecutionArtifact = vi.fn(async (unitPath: string, ref = "main") => {
    const build = await getBuild(unitPath, ref);
    return registerExecution(build as typeof appBuild, ref).binding;
  });
  const buildSystem = {
    getBuild,
    resolveExecutionArtifact,
    getExecutionArtifact: vi.fn((digest: string) => executionBundles.get(digest) ?? null),
    getBuildByKey: vi.fn((key: string) => compilationRecords.get(key) ?? null),
    getSourceDigest: vi.fn((name: string) =>
      name === "@workspace-apps/shell" ? exact.binding.artifact.source.sourceEv : null
    ),
    getExternalDeps: vi.fn(() => ({})),
    getBuildProviderDetails: vi.fn(
      () =>
        null as {
          name: string;
          activeSourceDigest: string | null;
          activeBuildKey: string | null;
          contractVersion: string;
        } | null
    ),
    onBuildProviderChange: vi.fn(
      (
        callback: (event: {
          type: "registered" | "unregistered";
          target: "react-native";
          provider: {
            name: string;
            activeSourceDigest: string | null;
            activeBuildKey: string | null;
            contractVersion: string;
          };
        }) => void
      ) => {
        providerChangeCallbacks.push(callback);
        return () => {
          const index = providerChangeCallbacks.indexOf(callback);
          if (index >= 0) providerChangeCallbacks.splice(index, 1);
        };
      }
    ),
    getGraph: vi.fn(() => ({
      allNodes: () => [graphNode],
    })),
    onPushBuild: vi.fn(),
    onUnitChange: vi.fn(),
  };
  const eventService = { emit: vi.fn(), getOrCreateSubscriber: vi.fn(), subscribe: vi.fn() };
  const approvalQueue = {
    request: vi.fn(async () => opts.approvalDecision ?? ("once" as const)),
    listPending: vi.fn<() => PendingApproval[]>(() => []),
  };
  const notificationService = { show: vi.fn(() => "notification-id") };
  const entityCache = new EntityCache();
  const approvalCoordinator = opts.useApprovalCoordinator
    ? new ServerUnitApprovalCoordinator({ approvalQueue, delayMs: 10_000 })
    : undefined;
  const host = new AppHost({
    statePath: path.join(root, "state"),
    workspacePath,
    workspaceId: "ws",
    buildSystem,
    eventService: eventService as never,
    approvalQueue,
    approvalCoordinator,
    notificationService,
    entityCache,
    readWorkspaceFileAtCommit: opts.readWorkspaceFileAtCommit ?? (async () => null),
    getGatewayUrl: () => "http://127.0.0.1:1234",
    getReactNativeAppArtifactBaseUrl: () =>
      opts.reactNativeAppArtifactBaseUrl ?? "http://127.0.0.1:1234",
    getTerminalAppArtifactBaseUrl: () => opts.terminalAppArtifactBaseUrl ?? "http://127.0.0.1:1234",
    // Manifest-declared preferred app per host target (mirrors the shipped
    // meta/vibestudio.yml hostTargets seed). Preferences come from the manifest,
    // never from hardcoded unit names in the host.
    getHostTargetDecl: (target) =>
      target === "electron"
        ? { appSource: "apps/shell", requiresExtensions: [] }
        : target === "react-native"
          ? { appSource: "apps/mobile", requiresExtensions: ["extensions/react-native"] }
          : { appSource: "apps/remote-cli", requiresExtensions: [] },
  });
  return {
    host,
    buildSystem,
    eventService,
    approvalQueue,
    approvalCoordinator,
    notificationService,
    graphNode,
    appPath,
    root,
    workspacePath,
    entityCache,
    providerChangeCallbacks,
    registerExecution,
  };
}

function panelCaller(callerId = "panel-1") {
  return createVerifiedCaller(callerId, "panel", {
    callerId,
    callerKind: "panel",
    repoPath: "panels/test",
    executionDigest: "sourceDigest-panel",
    requested: [
      { capability: "service:*", resource: { kind: "prefix", prefix: "" } },
      { capability: "rpc:*", resource: { kind: "prefix", prefix: "" } },
    ],
  });
}

function installApp(host: AppHost, graphNode: ReturnType<typeof makeHarness>["graphNode"]): void {
  host.registry.upsert({
    unitKind: "app",
    name: graphNode.name,
    version: "1.0.0",
    target: "electron",
    capabilities: ["notifications"],
    source: { kind: "workspace-repo", repo: graphNode.relativePath, ref: "main" },
    installedAt: Date.now(),
    activeSourceDigest: TEST_APP_EXECUTION.binding.artifact.source.sourceEv,
    activeExecutionDigest: TEST_APP_EXECUTION.binding.artifact.executionDigest,
    activeSourceHash: "abc123",
    activeBundleKey: "app-key",
    activeDependencySourceDigests: {},
    activeExternalDeps: {},
    activeRuntimeDepsKey: null,
    status: "running",
    lastError: null,
    previousVersions: [],
  });
}

function createAppGraphNode(
  workspacePath: string,
  source: string,
  opts: {
    name: string;
    target: "electron" | "react-native" | "terminal";
    capabilities?: string[];
    displayName?: string;
  }
) {
  const appPath = path.join(workspacePath, source);
  fs.mkdirSync(appPath, { recursive: true });
  fs.writeFileSync(
    path.join(appPath, "package.json"),
    JSON.stringify({
      name: opts.name,
      version: "1.0.0",
      vibestudio: {
        displayName: opts.displayName ?? opts.name,
        app: {
          target: opts.target,
          renderer: opts.target === "terminal" ? "index.mjs" : "index.tsx",
          capabilities: opts.capabilities ?? [],
        },
        authority: testAuthority(opts.capabilities ?? []),
      },
    })
  );
  fs.writeFileSync(
    path.join(appPath, opts.target === "terminal" ? "index.mjs" : "index.tsx"),
    "export default null;\n"
  );
  return {
    name: opts.name,
    kind: "app" as const,
    relativePath: source,
    path: appPath,
    internalDeps: [],
    manifest: {
      displayName: opts.displayName ?? opts.name,
      app: { target: opts.target, capabilities: opts.capabilities ?? [] },
      authority: testAuthority(opts.capabilities ?? []),
    },
  };
}

function setAppManifestTarget(
  node: ReturnType<typeof makeHarness>["graphNode"],
  target: "electron" | "react-native" | "terminal",
  capabilities: string[] = [...node.manifest.app.capabilities]
): void {
  node.manifest.app.target = target as never;
  node.manifest.app.capabilities = capabilities as never;
  const appBlock =
    target === "terminal"
      ? { target, entry: "index.ts", capabilities }
      : target === "react-native"
        ? {
            target,
            renderer: "index.tsx",
            rnComponentName: "VibestudioMobile",
            rnHostAbi: "rn-host-2",
            capabilities,
          }
        : { target, renderer: "index.tsx", capabilities };
  fs.writeFileSync(
    path.join(node.path, "package.json"),
    JSON.stringify({
      name: node.name,
      version: "1.0.0",
      vibestudio: {
        displayName: node.manifest.displayName,
        app: appBlock,
        authority: testAuthority(capabilities),
      },
    })
  );
}

function installAppEntry(
  host: AppHost,
  node: {
    name: string;
    relativePath: string;
    manifest: {
      app: {
        target: "electron" | "react-native" | "terminal";
        capabilities: readonly string[];
      };
    };
  },
  opts: {
    target?: "electron" | "react-native" | "terminal";
    activeBundleKey?: string;
    activeSourceDigest?: string;
    activeExecutionDigest?: string;
    capabilities?: string[];
    previousVersions?: Array<{
      activeBundleKey: string;
      activeSourceDigest: string | null;
      activeExecutionDigest?: string | null;
      target?: "electron" | "react-native" | "terminal";
      capabilities?: string[];
    }>;
  } = {}
): void {
  const target = opts.target ?? node.manifest.app.target;
  host.registry.upsert({
    unitKind: "app",
    name: node.name,
    version: "1.0.0",
    target,
    capabilities: (opts.capabilities ?? node.manifest.app.capabilities) as never,
    source: { kind: "workspace-repo", repo: node.relativePath, ref: "main" },
    installedAt: Date.now(),
    activeSourceDigest: opts.activeSourceDigest ?? `sourceDigest-${node.name}`,
    activeExecutionDigest: opts.activeExecutionDigest ?? `execution-${node.name}`,
    activeSourceHash: "abc123",
    activeBundleKey: opts.activeBundleKey ?? `${node.name}-key`,
    activeDependencySourceDigests: {},
    activeExternalDeps: {},
    activeRuntimeDepsKey: null,
    status: target === "terminal" ? "available" : "running",
    lastError: null,
    previousVersions: (opts.previousVersions ?? []).map((version) => ({
      version: "1.0.0",
      target: version.target ?? target,
      capabilities: (version.capabilities ??
        opts.capabilities ??
        node.manifest.app.capabilities) as never,
      activeSourceDigest: version.activeSourceDigest,
      activeExecutionDigest:
        version.activeExecutionDigest ?? `execution-${version.activeBundleKey}`,
      activeSourceHash: "previous-sha",
      activeBundleKey: version.activeBundleKey,
      activeDependencySourceDigests: {},
      activeExternalDeps: {},
      activeRuntimeDepsKey: null,
      activatedAt: Date.now() - 1000,
    })),
  });
}

async function flushAsyncWork(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await Promise.resolve();
}

function createMockResponse() {
  return {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: Buffer.alloc(0) as Buffer<ArrayBufferLike>,
    writeHead(statusCode: number, headers: Record<string, string>) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(chunk?: string | Buffer) {
      this.body = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(typeof chunk === "string" ? chunk : "");
    },
  };
}

describe("AppHost", () => {
  it("computes meta-change approvals from committed workspace config", async () => {
    const readWorkspaceFileAtCommit = vi.fn(async () => "apps:\n  - source: apps/shell\n");
    const { host } = makeHarness({ readWorkspaceFileAtCommit });

    const approval = await host.metaChangeApprovalForCommit("state:next");

    expect(readWorkspaceFileAtCommit).toHaveBeenCalledWith("state:next", "meta/vibestudio.yml");
    expect(approval.units).toEqual([
      expect.objectContaining({
        unitKind: "app",
        unitName: "@workspace-apps/shell",
        source: { kind: "workspace-repo", repo: "apps/shell", ref: "main" },
      }),
    ]);
  });

  it("builds, registers, and emits available Electron apps from trusted main", async () => {
    const { host, buildSystem, eventService, entityCache } = makeHarness();

    await host.reconcileDeclared([{ source: "apps/shell", ref: "main" }]);
    await host.whenSettled();

    expect(buildSystem.getBuild).toHaveBeenCalledWith("@workspace-apps/shell", "main");
    expect(host.registry.get("@workspace-apps/shell")).toMatchObject({
      unitKind: "app",
      target: "electron",
      activeBundleKey: "app-key",
      activeSourceHash: "state:test",
      status: "running",
    });
    expect(eventService.emit).toHaveBeenCalledWith(
      "apps:available",
      expect.objectContaining({
        appId: "@workspace-apps/shell",
        target: "electron",
        artifactRoute: "/_a/app-key/index.html",
        capabilities: ["notifications"],
      })
    );
    expect(entityCache.resolveActive("@workspace-apps/shell")).toMatchObject({
      id: "@workspace-apps/shell",
      kind: "app",
      source: { repoPath: "apps/shell" },
      status: "active",
    });
  });

  it("registers existing approved Electron apps when reusing the active build after restart", async () => {
    const { host, buildSystem, entityCache, graphNode } = makeHarness();
    installApp(host, graphNode);

    expect(entityCache.resolveActive("@workspace-apps/shell")).toBeNull();

    await host.reconcileDeclared([{ source: "apps/shell", ref: "main" }]);
    await host.whenSettled();

    expect(buildSystem.getBuild).not.toHaveBeenCalled();
    expect(entityCache.resolveActive("@workspace-apps/shell")).toMatchObject({
      id: "@workspace-apps/shell",
      kind: "app",
      source: { repoPath: "apps/shell" },
      status: "active",
    });
  });

  it("surfaces push rebuild failures and keeps the previous app build active", async () => {
    const { host, buildSystem, eventService, notificationService, graphNode } = makeHarness();
    installApp(host, graphNode);
    buildSystem.getBuild.mockRejectedValueOnce(new Error("broken app code"));

    const onPush = buildSystem.onPushBuild.mock.calls[0]?.[0] as
      | ((source: string) => void)
      | undefined;
    expect(onPush).toBeDefined();
    onPush?.("apps/shell");
    await flushAsyncWork();

    expect(host.registry.get("@workspace-apps/shell")).toMatchObject({
      status: "error",
      lastError: "broken app code",
      lastErrorDetails: expect.objectContaining({ phase: "build", source: "apps/shell" }),
      activeBundleKey: "app-key",
      activeSourceDigest: APP_SOURCE,
    });
    expect(eventService.emit).toHaveBeenCalledWith(
      "apps:status",
      expect.objectContaining({
        name: "@workspace-apps/shell",
        status: "error",
        error: "broken app code",
        errorDetails: expect.objectContaining({ phase: "build", source: "apps/shell" }),
        buildKey: "app-key",
        canRollback: false,
      })
    );
    expect(eventService.emit).toHaveBeenCalledWith(
      "apps:lifecycle",
      expect.objectContaining({
        type: "update-error",
        appId: "@workspace-apps/shell",
        error: "broken app code",
        errorDetails: expect.objectContaining({ phase: "build", source: "apps/shell" }),
      })
    );
    expect(notificationService.show).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        title: "App update failed",
      })
    );
  });

  it("rebuilds an installed app when its main-head effective version changes", async () => {
    const { host, buildSystem, eventService, graphNode } = makeHarness();
    installApp(host, graphNode);
    const changedBuild = {
      dir: path.join(path.dirname(graphNode.path), "..", "..", "state", "builds", "app-key-2"),
      metadata: {
        sourceDigest: APP_SOURCE_2,
        sourceStateHash: "state:test",
        details: { kind: "app" as const, target: "electron" as const, integrity: "sha256-app-2" },
      },
      artifacts: [
        {
          path: "index.html",
          role: "html",
          contentType: "text/html; charset=utf-8",
          encoding: "utf8",
          content: "<!doctype html><div>new</div>",
        },
      ],
    };
    buildSystem.getBuild.mockResolvedValueOnce(changedBuild as never);

    const onUnitChange = buildSystem.onUnitChange.mock.calls[0]?.[0] as
      | ((event: {
          name: string;
          relativePath: string;
          kind: string;
          trigger: { head: string };
        }) => void)
      | undefined;
    expect(onUnitChange).toBeDefined();

    onUnitChange?.({
      name: "@workspace-apps/shell",
      relativePath: "apps/shell",
      kind: "app",
      trigger: { head: "ctx:other" },
    });
    await flushAsyncWork();
    expect(buildSystem.getBuild).not.toHaveBeenCalled();

    onUnitChange?.({
      name: "@workspace-apps/shell",
      relativePath: "apps/shell",
      kind: "app",
      trigger: { head: "main" },
    });
    await flushAsyncWork();

    expect(buildSystem.getBuild).toHaveBeenCalledWith("@workspace-apps/shell", "main");
    expect(host.registry.get("@workspace-apps/shell")).toMatchObject({
      status: "running",
      activeBundleKey: "app-key-2",
      activeSourceDigest: APP_SOURCE_2,
      previousVersions: [
        expect.objectContaining({ activeBundleKey: "app-key", activeSourceDigest: APP_SOURCE }),
      ],
    });
    expect(eventService.emit).toHaveBeenCalledWith(
      "apps:lifecycle",
      expect.objectContaining({
        type: "update-available",
        appId: "@workspace-apps/shell",
        buildKey: "app-key-2",
      })
    );
  });

  it("records app version history and can roll back to the previous build", async () => {
    const { host, buildSystem, eventService, notificationService, graphNode, registerExecution } =
      makeHarness();
    installApp(host, graphNode);
    const buildByKey = new Map([
      [
        "app-key",
        {
          dir: path.join(path.dirname(graphNode.path), "..", "..", "state", "builds", "app-key"),
          metadata: {
            sourceDigest: APP_SOURCE,
            sourceStateHash: "state:test",
            details: { kind: "app" as const, target: "electron" as const, integrity: "sha256-app" },
          },
          artifacts: [
            {
              path: "index.html",
              role: "html",
              contentType: "text/html; charset=utf-8",
              encoding: "utf8",
              content: "<!doctype html><div>old</div>",
            },
          ],
        },
      ],
      [
        "app-key-2",
        {
          dir: path.join(path.dirname(graphNode.path), "..", "..", "state", "builds", "app-key-2"),
          metadata: {
            sourceDigest: APP_SOURCE_2,
            sourceStateHash: "state:test",
            details: {
              kind: "app" as const,
              target: "electron" as const,
              integrity: "sha256-app-2",
            },
          },
          artifacts: [
            {
              path: "index.html",
              role: "html",
              contentType: "text/html; charset=utf-8",
              encoding: "utf8",
              content: "<!doctype html><div>new</div>",
            },
          ],
        },
      ],
    ]);
    buildSystem.getBuildByKey.mockImplementation(
      (key: string) => (buildByKey.get(key) ?? null) as never
    );
    const oldExecution = registerExecution(buildByKey.get("app-key")! as never);
    host.registry.patch("@workspace-apps/shell", {
      activeExecutionDigest: oldExecution.binding.artifact.executionDigest,
    });
    buildSystem.getBuild.mockResolvedValueOnce(buildByKey.get("app-key-2")! as never);

    const onPush = buildSystem.onPushBuild.mock.calls[0]?.[0] as
      | ((source: string) => void)
      | undefined;
    expect(onPush).toBeDefined();
    onPush?.("apps/shell");
    await flushAsyncWork();

    expect(host.registry.get("@workspace-apps/shell")).toMatchObject({
      status: "running",
      activeBundleKey: "app-key-2",
      activeSourceDigest: APP_SOURCE_2,
      previousVersions: [
        expect.objectContaining({ activeBundleKey: "app-key", activeSourceDigest: APP_SOURCE }),
      ],
    });
    expect(notificationService.show).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "info",
        title: "Desktop app update available",
        actions: expect.arrayContaining([
          expect.objectContaining({
            id: "app.applyUpdate",
            command: { type: "app.applyUpdate", appId: "@workspace-apps/shell" },
          }),
          expect.objectContaining({
            id: "app.rollback",
            command: { type: "app.rollback", appId: "@workspace-apps/shell" },
          }),
        ]),
      })
    );
    const res = createMockResponse();
    host.handleAppArtifactRequest(
      { method: "GET" } as never,
      res as never,
      "app-key",
      "index.html"
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.toString()).toContain("old");

    await host.rollbackAppVersion("@workspace-apps/shell");

    expect(host.registry.get("@workspace-apps/shell")).toMatchObject({
      status: "running",
      activeBundleKey: "app-key",
      activeSourceDigest: APP_SOURCE,
      previousVersions: [
        expect.objectContaining({ activeBundleKey: "app-key-2", activeSourceDigest: APP_SOURCE_2 }),
      ],
    });
    expect(eventService.emit).toHaveBeenCalledWith(
      "apps:lifecycle",
      expect.objectContaining({
        type: "rolled-back",
        appId: "@workspace-apps/shell",
        buildKey: "app-key",
        canRollback: true,
      })
    );
  });

  it("persists host target selections and invalidates them when the app disappears", () => {
    const { host, buildSystem, graphNode } = makeHarness();
    graphNode.manifest.app.capabilities = ["panel-hosting"] as never;

    const selection = host.setHostTargetSelection("electron", {
      source: "apps/shell",
      mode: "follow-ref",
    });

    expect(selection).toMatchObject({
      workspaceId: "ws",
      target: "electron",
      source: "apps/shell",
      appId: "@workspace-apps/shell",
      mode: "follow-ref",
    });
    expect(host.getHostTargetSelection("electron")).toMatchObject({
      valid: true,
      selection: expect.objectContaining({ source: "apps/shell" }),
    });
    buildSystem.getGraph.mockReturnValueOnce({ allNodes: () => [] } as never);
    expect(host.getHostTargetSelection("electron")).toMatchObject({
      valid: false,
      reason: "Selected app is no longer available",
    });
  });

  it("auto-selects and launches the canonical Electron shell when no host selection is stored", async () => {
    const { host, eventService, graphNode } = makeHarness();
    graphNode.manifest.app.capabilities = ["panel-hosting"] as never;
    installApp(host, graphNode);

    expect(host.getHostTargetSelection("electron")).toMatchObject({
      valid: true,
      selection: expect.objectContaining({
        source: "apps/shell",
        appId: "@workspace-apps/shell",
        mode: "follow-ref",
        autoSelected: true,
      }),
    });

    await expect(host.launchHostTarget("electron")).resolves.toMatchObject({
      status: "ready",
      launched: true,
      target: "electron",
      source: "apps/shell",
      appId: "@workspace-apps/shell",
    });
    expect(eventService.emit).toHaveBeenCalledWith(
      "apps:available",
      expect.objectContaining({
        appId: "@workspace-apps/shell",
        source: "apps/shell",
        target: "electron",
        selectedForHost: true,
      })
    );
  });

  it("prepares an unbuilt selected Electron shell before launching", async () => {
    const { host, buildSystem, eventService, graphNode } = makeHarness();
    graphNode.manifest.app.capabilities = ["panel-hosting"] as never;

    host.setDeclared([{ source: "apps/shell", ref: "main" }]);

    await expect(host.launchHostTarget("electron")).resolves.toMatchObject({
      status: "ready",
      launched: true,
      target: "electron",
      source: "apps/shell",
      appId: "@workspace-apps/shell",
    });
    expect(buildSystem.getBuild).toHaveBeenCalledWith("@workspace-apps/shell", "main");
    expect(host.registry.get("@workspace-apps/shell")).toMatchObject({
      target: "electron",
      activeBundleKey: "app-key",
      status: "running",
    });
    expect(eventService.emit).toHaveBeenCalledWith(
      "apps:available",
      expect.objectContaining({
        appId: "@workspace-apps/shell",
        source: "apps/shell",
        target: "electron",
        selectedForHost: true,
      })
    );
  });

  it("records app declarations passively and prepares only the selected host target", async () => {
    const { host, buildSystem, approvalQueue, graphNode, workspacePath } = makeHarness();
    graphNode.manifest.app.capabilities = ["panel-hosting"] as never;
    const mobileNode = createAppGraphNode(workspacePath, "apps/mobile", {
      name: "@workspace-apps/mobile",
      target: "react-native",
      capabilities: ["notifications"],
    });
    buildSystem.getGraph.mockReturnValue({
      allNodes: () => [graphNode, mobileNode],
    } as never);

    host.setDeclared([
      { source: "apps/shell", ref: "main" },
      { source: "apps/mobile", ref: "main" },
    ]);

    expect(approvalQueue.request).not.toHaveBeenCalled();
    expect(buildSystem.getBuild).not.toHaveBeenCalled();

    await expect(host.ensureElectronReady()).resolves.toMatchObject({
      ready: true,
      source: "apps/shell",
      appId: "@workspace-apps/shell",
    });

    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "unit-batch",
        trigger: "startup",
        title: "Approve workspace apps",
        units: [
          expect.objectContaining({
            unitKind: "app",
            unitName: "@workspace-apps/shell",
            source: { kind: "workspace-repo", repo: "apps/shell", ref: "main" },
          }),
        ],
      })
    );
    expect(buildSystem.getBuild.mock.calls).toEqual([["@workspace-apps/shell", "main"]]);
    expect(host.registry.get("@workspace-apps/mobile")).toBeNull();
  });

  it("launches the selected Electron shell after startup approval", async () => {
    const { host, buildSystem, eventService, graphNode, approvalQueue } = makeHarness();
    graphNode.manifest.app.capabilities = ["panel-hosting"] as never;

    await host.reconcileDeclared([{ source: "apps/shell", ref: "main" }]);
    await host.whenSettled();

    const launched = await host.launchHostTarget("electron");

    expect(launched).toMatchObject({
      status: "ready",
      launched: true,
      target: "electron",
    });
    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "unit-batch",
        trigger: "startup",
        units: [
          expect.objectContaining({
            unitKind: "app",
            unitName: "@workspace-apps/shell",
            target: "electron",
          }),
        ],
      })
    );
    expect(buildSystem.getBuild).toHaveBeenCalledWith("@workspace-apps/shell", "main");
    expect(eventService.emit).toHaveBeenCalledWith(
      "apps:available",
      expect.objectContaining({
        appId: "@workspace-apps/shell",
        source: "apps/shell",
        target: "electron",
        selectedForHost: true,
      })
    );
  });

  it("publishes pending startup approvals through the shared coordinator", async () => {
    const { host, graphNode, approvalQueue, approvalCoordinator } = makeHarness({
      useApprovalCoordinator: true,
    });
    graphNode.manifest.app.capabilities = ["panel-hosting"] as never;

    await host.reconcileDeclared([{ source: "apps/shell", ref: "main" }]);

    expect(host.registry.get(graphNode.name)).toMatchObject({ status: "pending-approval" });
    expect(approvalQueue.request).not.toHaveBeenCalled();

    approvalCoordinator?.publishPending("startup");

    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "unit-batch",
        trigger: "startup",
        units: [
          expect.objectContaining({
            unitKind: "app",
            unitName: "@workspace-apps/shell",
            target: "electron",
          }),
        ],
      })
    );
  });

  it("ensures the selected Electron shell has an active HTML build before desktop pairing", async () => {
    const { host, buildSystem, graphNode } = makeHarness();
    graphNode.manifest.app.capabilities = ["panel-hosting"] as never;

    host.setDeclared([{ source: "apps/shell", ref: "main" }]);
    const readiness = await host.ensureElectronReady();

    expect(readiness).toMatchObject({
      ready: true,
      source: "apps/shell",
      appId: "@workspace-apps/shell",
      buildKey: "app-key",
      artifactRoute: "/_a/app-key/index.html",
    });
    expect(buildSystem.getBuild).toHaveBeenCalledWith("@workspace-apps/shell", "main");
  });

  it("advertises Electron shell artifacts as gateway routes", async () => {
    const { host, eventService, graphNode } = makeHarness({
      reactNativeAppArtifactBaseUrl: "https://host.tailnet.ts.net",
    });
    graphNode.manifest.app.capabilities = ["panel-hosting"] as never;

    host.setDeclared([{ source: "apps/shell", ref: "main" }]);
    const readiness = await host.ensureElectronReady();

    expect(readiness).toMatchObject({
      ready: true,
      source: "apps/shell",
      appId: "@workspace-apps/shell",
      buildKey: "app-key",
      artifactRoute: "/_a/app-key/index.html",
    });
    expect(eventService.emit).toHaveBeenCalledWith(
      "apps:available",
      expect.objectContaining({
        appId: "@workspace-apps/shell",
        source: "apps/shell",
        target: "electron",
        artifactRoute: "/_a/app-key/index.html",
        artifacts: expect.arrayContaining([
          expect.objectContaining({
            path: "index.html",
            route: "/_a/app-key/index.html",
          }),
        ]),
      })
    );
  });

  it("marks unselected Electron app availability events for the host to ignore", async () => {
    const { host, buildSystem, eventService, graphNode, workspacePath } = makeHarness();
    graphNode.manifest.app.capabilities = ["panel-hosting"] as never;
    const altNode = createAppGraphNode(workspacePath, "apps/desktop-alt", {
      name: "@workspace-apps/desktop-alt",
      target: "electron",
      capabilities: ["panel-hosting"],
    });
    buildSystem.getGraph.mockReturnValue({
      allNodes: () => [graphNode, altNode],
    } as never);

    host.setHostTargetSelection("electron", { source: "apps/desktop-alt" });
    await host.reconcileDeclared([{ source: "apps/shell", ref: "main" }]);
    await host.whenSettled();

    expect(eventService.emit).toHaveBeenCalledWith(
      "apps:available",
      expect.objectContaining({
        appId: "@workspace-apps/shell",
        selectedForHost: false,
      })
    );
  });

  it("projects capabilities granted to the exact artifact source", async () => {
    const { host, eventService, graphNode } = makeHarness();
    graphNode.manifest.app.capabilities = ["panel-hosting", "notifications"] as never;

    await host.reconcileDeclared([{ source: "apps/shell", ref: "main" }]);
    await host.whenSettled();

    expect(eventService.emit).toHaveBeenCalledWith(
      "apps:available",
      expect.objectContaining({
        appId: "@workspace-apps/shell",
        source: "apps/shell",
        capabilities: expect.arrayContaining(["panel-hosting", "notifications"]),
      })
    );
  });

  it("strips capabilities from a source absent from the exact product catalog", async () => {
    const { host, eventService, graphNode } = makeHarness();
    graphNode.relativePath = "apps/unreviewed";
    graphNode.manifest.app.capabilities = ["panel-hosting", "notifications"] as never;

    await host.reconcileDeclared([{ source: "apps/unreviewed", ref: "main" }]);
    await host.whenSettled();

    expect(eventService.emit).toHaveBeenCalledWith(
      "apps:available",
      expect.objectContaining({
        appId: "@workspace-apps/shell",
        source: "apps/unreviewed",
        capabilities: [],
      })
    );
  });

  it("uses the selected React Native source instead of the canonical mobile fallback", () => {
    const { host, buildSystem, graphNode, workspacePath } = makeHarness();
    const otherNode = createAppGraphNode(workspacePath, "apps/field-mobile", {
      name: "@workspace-apps/field-mobile",
      target: "react-native",
      capabilities: ["notifications"],
    });
    buildSystem.getGraph.mockReturnValue({
      allNodes: () => [graphNode, otherNode],
    } as never);
    const rnBuild = (sourceDigest: string) => ({
      dir: path.join(workspacePath, "..", "state", "builds", sourceDigest),
      metadata: {
        sourceDigest,
        details: {
          kind: "app" as const,
          target: "react-native" as const,
          integrity: `sha256-${sourceDigest}`,
          rnHostAbi: "rn-host-2",
          provider: REACT_NATIVE_PROVIDER,
        },
      },
      artifacts: [
        {
          path: "index.ios.bundle",
          role: "primary",
          contentType: "application/javascript; charset=utf-8",
          encoding: "utf8",
          platform: "ios",
          integrity: `sha256-${sourceDigest}-ios`,
          content: "bundle",
        },
      ],
    });
    buildSystem.getBuildByKey.mockImplementation((key: string) => {
      if (key === "mobile-key") return rnBuild("sourceDigest-mobile") as never;
      if (key === "field-key") return rnBuild("sourceDigest-field") as never;
      return null;
    });
    installAppEntry(host, graphNode, {
      target: "react-native",
      activeBundleKey: "mobile-key",
      activeSourceDigest: "sourceDigest-mobile",
      capabilities: ["notifications"],
    });
    host.registry.patch(graphNode.name, {
      source: { kind: "workspace-repo", repo: "apps/mobile", ref: "main" },
    });
    installAppEntry(host, otherNode, {
      target: "react-native",
      activeBundleKey: "field-key",
      activeSourceDigest: "sourceDigest-field",
      capabilities: ["notifications", "panel-hosting"],
    });

    host.setHostTargetSelection("react-native", { source: "apps/field-mobile" });

    expect(host.reactNative.getBootstrap()).toMatchObject({
      appId: "@workspace-apps/field-mobile",
      buildKey: "field-key",
      executionDigest: "execution-@workspace-apps/field-mobile",
    });
    expect(host.reactNative.registerPrincipal("device-1")).toBe("app:apps/field-mobile:device-1");
  });

  it("records explicit host trust identity when activating a pinned ref", async () => {
    const { host, buildSystem, graphNode, root } = makeHarness();
    graphNode.manifest.app.capabilities = ["panel-hosting", "notifications"] as never;
    const pinnedBuild = {
      dir: path.join(root, "state", "builds", "pinned-ref-key"),
      metadata: {
        sourceDigest: "sourceDigest-pinned",
        sourceStateHash: "state:test",
        details: { kind: "app" as const, target: "electron" as const, integrity: "sha256-pinned" },
      },
      artifacts: [
        {
          path: "index.html",
          role: "html",
          contentType: "text/html; charset=utf-8",
          encoding: "utf8",
          content: "<!doctype html><div>pinned</div>",
        },
      ],
    };
    buildSystem.getBuild.mockResolvedValueOnce(pinnedBuild as never);

    const pinnedState = sha256("pinned-state");
    const result = await host.prepareHostTargetPinnedRef(
      "electron",
      "apps/shell",
      `state:${pinnedState}`
    );

    expect(result).toMatchObject({
      buildKey: "pinned-ref-key",
      executionDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      appId: "@workspace-apps/shell",
      source: "apps/shell",
    });
    const entry = host.registry.get("@workspace-apps/shell");
    expect(entry).toMatchObject({
      activeBundleKey: "pinned-ref-key",
      activeSourceDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
      source: { ref: `state:${pinnedState}` },
      activationTrust: {
        decision: "host-target-pinned-ref",
        actor: "shell-host",
        reason: expect.stringContaining("explicit ref"),
      },
    });
    const identity = JSON.parse(entry?.activationTrust?.identityKey ?? "{}");
    expect(identity).toMatchObject({
      unitKind: "app",
      name: "@workspace-apps/shell",
      source: { repo: "apps/shell", ref: `state:${pinnedState}` },
      sourceDigest: entry?.activeSourceDigest,
      capabilities: ["notifications", "panel-hosting"],
    });
  });

  it("keeps pinned host target builds active when a newer build is produced", async () => {
    const { host, buildSystem, graphNode } = makeHarness();
    graphNode.manifest.app.capabilities = ["panel-hosting"] as never;
    const buildByKey = new Map([
      [
        "app-key",
        {
          dir: path.join(path.dirname(graphNode.path), "..", "..", "state", "builds", "app-key"),
          metadata: {
            sourceDigest: APP_SOURCE,
            sourceStateHash: "state:test",
            details: { kind: "app" as const, target: "electron" as const, integrity: "sha256-app" },
          },
          artifacts: [
            {
              path: "index.html",
              role: "html",
              contentType: "text/html; charset=utf-8",
              encoding: "utf8",
              content: "<!doctype html><div>old</div>",
            },
          ],
        },
      ],
      [
        "app-key-2",
        {
          dir: path.join(path.dirname(graphNode.path), "..", "..", "state", "builds", "app-key-2"),
          metadata: {
            sourceDigest: APP_SOURCE_2,
            sourceStateHash: "state:test",
            details: {
              kind: "app" as const,
              target: "electron" as const,
              integrity: "sha256-app-2",
            },
          },
          artifacts: [
            {
              path: "index.html",
              role: "html",
              contentType: "text/html; charset=utf-8",
              encoding: "utf8",
              content: "<!doctype html><div>new</div>",
            },
          ],
        },
      ],
    ]);
    buildSystem.getBuildByKey.mockImplementation(
      (key: string) => (buildByKey.get(key) ?? null) as never
    );
    installAppEntry(host, graphNode, {
      target: "electron",
      activeBundleKey: "app-key",
      activeSourceDigest: APP_SOURCE,
      capabilities: ["panel-hosting"],
    });
    host.setHostTargetSelection("electron", {
      source: "apps/shell",
      mode: "pinned-build",
      buildKey: "app-key",
    });
    buildSystem.getBuild.mockResolvedValueOnce(buildByKey.get("app-key-2") as never);

    const onPush = buildSystem.onPushBuild.mock.calls[0]?.[0] as
      | ((source: string) => void)
      | undefined;
    expect(onPush).toBeDefined();
    onPush?.("apps/shell");
    await flushAsyncWork();

    expect(host.registry.get("@workspace-apps/shell")).toMatchObject({
      activeBundleKey: "app-key",
      activeSourceDigest: APP_SOURCE,
      previousVersions: [],
    });
  });

  it("emits a development app status diagnostic", async () => {
    process.env["VIBESTUDIO_APP_DEV_STATUS"] = "1";
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => {});
    const { host } = makeHarness();

    try {
      await host.reconcileDeclared([{ source: "apps/shell", ref: "main" }]);
      await host.whenSettled();

      expect(consoleInfo).toHaveBeenCalledWith(expect.stringContaining("@workspace-apps/shell"));
      expect(consoleInfo).toHaveBeenCalledWith(
        expect.stringContaining(`sourceDigest=${APP_SOURCE.slice(0, 12)}`)
      );
      expect(consoleInfo).toHaveBeenCalledWith(expect.stringContaining("build=app-key"));
      expect(consoleInfo).toHaveBeenCalledWith(expect.stringContaining("ref=main"));
    } finally {
      consoleInfo.mockRestore();
    }
  });

  it("bakes only the active approved app build for dist packaging", () => {
    const { host, graphNode } = makeHarness();
    installApp(host, graphNode);
    const outDir = path.join(tempRoot(), "dist", "baked-app");

    const manifest = host.bakeDist("apps/shell", outDir);

    expect(manifest).toMatchObject({
      app: {
        name: "@workspace-apps/shell",
        source: "apps/shell",
        target: "electron",
      },
      build: {
        key: TEST_APP_EXECUTION.binding.artifact.buildKey,
        compilationCacheKey: "app-key",
        executionDigest: TEST_APP_EXECUTION.binding.artifact.executionDigest,
        target: "electron",
        integrity: "sha256-app",
      },
    });
    expect(fs.existsSync(path.join(outDir, "manifest.json"))).toBe(true);
    expect(fs.readFileSync(path.join(outDir, "artifacts", "index.html"), "utf8")).toBe(
      "<!doctype html><div>app</div>"
    );
  });

  it("registers device-scoped React Native app principals for native-held grants", async () => {
    const { host, graphNode, entityCache } = makeHarness();
    installApp(host, graphNode);
    host.registry.patch(graphNode.name, {
      target: "react-native",
      source: { kind: "workspace-repo", repo: "apps/mobile", ref: "main" },
      activeSourceDigest: "sourceDigest-mobile",
      activeBundleKey: "mobile-key",
      capabilities: ["notifications"],
    });

    const callerId = host.reactNative.registerPrincipal("device-1");

    expect(callerId).toBe("app:apps/mobile:device-1");
    expect(entityCache.resolveActive("app:apps/mobile:device-1")).toMatchObject({
      id: "app:apps/mobile:device-1",
      kind: "app",
      source: { repoPath: "apps/mobile" },
      status: "active",
    });

    expect(host.reactNative.retirePrincipal("device-1")).toBe(1);
    expect(entityCache.resolveActive("app:apps/mobile:device-1")).toBeNull();
  });

  it("registers mobile app grants for the same canonical source used by bootstrap", async () => {
    const { host, graphNode, entityCache } = makeHarness();
    installApp(host, graphNode);
    const base = host.registry.get(graphNode.name);
    if (!base) throw new Error("expected test app registry entry");
    host.registry.patch(graphNode.name, {
      target: "react-native",
      source: { kind: "workspace-repo", repo: "apps/other-mobile", ref: "main" },
      activeSourceDigest: "sourceDigest-other-mobile",
      activeBundleKey: "other-mobile-key",
      capabilities: ["notifications"],
    });
    host.registry.upsert({
      ...base,
      name: "@workspace-apps/mobile",
      target: "react-native",
      source: { kind: "workspace-repo", repo: "apps/mobile", ref: "main" },
      activeSourceDigest: "sourceDigest-mobile",
      activeBundleKey: "mobile-key",
      capabilities: ["notifications"],
    });

    const callerId = host.reactNative.registerPrincipal("device-1");

    expect(callerId).toBe("app:apps/mobile:device-1");
    expect(entityCache.resolveActive("app:apps/mobile:device-1")).toMatchObject({
      source: { repoPath: "apps/mobile" },
    });
    expect(entityCache.resolveActive("app:apps/other-mobile:device-1")).toBeNull();
  });

  it("activates terminal apps as launchable terminal process builds", async () => {
    const { host, buildSystem, eventService, graphNode, approvalQueue } = makeHarness();
    fs.writeFileSync(
      path.join(graphNode.path, "package.json"),
      JSON.stringify({
        name: "@workspace-apps/shell",
        version: "1.0.0",
        vibestudio: {
          displayName: "Remote CLI",
          app: {
            target: "terminal",
            entry: "index.ts",
            capabilities: ["clipboard"],
          },
          authority: testAuthority(["clipboard"]),
        },
      })
    );
    graphNode.manifest = {
      displayName: "Remote CLI",
      app: { target: "terminal", capabilities: ["clipboard"] },
      authority: testAuthority(["clipboard"]),
    } as never;
    const terminalBuild = {
      dir: path.join(path.dirname(graphNode.path), "..", "..", "state", "builds", "terminal-key"),
      metadata: {
        sourceDigest: "sourceDigest-terminal",
        sourceStateHash: "state:test",
        details: {
          kind: "app",
          target: "terminal",
          integrity: null,
          rnHostAbi: null,
          provider: null,
        },
      },
      artifacts: [
        {
          path: "index.mjs",
          role: "primary",
          contentType: "text/javascript; charset=utf-8",
          encoding: "utf8",
          content: "export {};\n",
        },
      ],
    };
    buildSystem.getBuild.mockResolvedValueOnce(terminalBuild as never);
    buildSystem.getBuildByKey.mockImplementation((key: string) =>
      key === "terminal-key" ? (terminalBuild as never) : null
    );

    await host.reconcileDeclared([
      {
        source: graphNode.relativePath,
        ref: "main",
      },
    ]);
    await host.whenSettled();

    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "unit-batch",
        trigger: "startup",
        units: [
          expect.objectContaining({
            unitKind: "app",
            unitName: graphNode.name,
            target: "terminal",
            source: { kind: "workspace-repo", repo: graphNode.relativePath, ref: "main" },
          }),
        ],
      })
    );
    expect(host.registry.get(graphNode.name)).toMatchObject({
      target: "terminal",
      activeBundleKey: "terminal-key",
      capabilities: ["clipboard"],
      status: "available",
    });
    expect(eventService.emit).toHaveBeenCalledWith(
      "apps:available",
      expect.objectContaining({
        appId: "@workspace-apps/shell",
        target: "terminal",
        launchMode: "terminal-process",
        url: "http://127.0.0.1:1234/_a/terminal-key/index.mjs",
      })
    );
    expect(eventService.emit).toHaveBeenCalledWith(
      "apps:status",
      expect.objectContaining({
        name: "@workspace-apps/shell",
        status: "available",
        error: null,
      })
    );
  });

  it("preserves an already-running terminal build during reconciliation and launch refresh", async () => {
    const { host, buildSystem, graphNode } = makeHarness();
    setAppManifestTarget(graphNode, "terminal", ["clipboard"]);
    const terminalBuild = {
      dir: path.join(path.dirname(graphNode.path), "..", "..", "state", "builds", "terminal-key"),
      metadata: {
        sourceDigest: "sourceDigest-terminal",
        sourceStateHash: "state:test",
        details: {
          kind: "app" as const,
          target: "terminal" as const,
          integrity: null,
          rnHostAbi: null,
          provider: null,
        },
      },
      artifacts: [
        {
          path: "index.mjs",
          role: "primary",
          contentType: "text/javascript; charset=utf-8",
          encoding: "utf8",
          content: "export {};\n",
        },
      ],
    };
    buildSystem.getBuild.mockResolvedValueOnce(terminalBuild as never);
    buildSystem.getBuildByKey.mockImplementation((key: string) =>
      key === "terminal-key" ? (terminalBuild as never) : null
    );

    await host.reconcileDeclared([{ source: graphNode.relativePath, ref: "main" }]);
    await host.whenSettled();

    const isRunningBuild = vi.spyOn(host.terminal, "isRunningBuild").mockReturnValue(true);
    const start = vi.spyOn(host.terminal, "start");
    const stop = vi.spyOn(host.terminal, "stop");
    host.registry.patch(graphNode.name, { status: "running" });

    await host.reconcileDeclared([{ source: graphNode.relativePath, ref: "main" }]);
    await host.whenSettled();
    expect(stop).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();

    await expect(host.launchHostTarget("terminal")).resolves.toMatchObject({
      status: "ready",
      target: "terminal",
      buildKey: "terminal-key",
    });
    expect(isRunningBuild).toHaveBeenCalledWith(graphNode.name, "terminal-key");
    expect(start).not.toHaveBeenCalled();
  });

  it("rolls terminal apps back to a retained terminal build", async () => {
    const { host, buildSystem, eventService, notificationService, graphNode, registerExecution } =
      makeHarness();
    const buildByKey = new Map([
      [
        "terminal-key-1",
        {
          dir: path.join(
            path.dirname(graphNode.path),
            "..",
            "..",
            "state",
            "builds",
            "terminal-key-1"
          ),
          metadata: {
            sourceDigest: "sourceDigest-terminal-1",
            sourceStateHash: "state:test",
            details: {
              kind: "app" as const,
              target: "terminal" as const,
              integrity: null,
              rnHostAbi: null,
              provider: null,
            },
          },
          artifacts: [
            {
              path: "index.mjs",
              role: "primary",
              contentType: "text/javascript; charset=utf-8",
              encoding: "utf8",
              content: "export {};\n",
            },
          ],
        },
      ],
      [
        "terminal-key-2",
        {
          dir: path.join(
            path.dirname(graphNode.path),
            "..",
            "..",
            "state",
            "builds",
            "terminal-key-2"
          ),
          metadata: {
            sourceDigest: "sourceDigest-terminal-2",
            sourceStateHash: "state:test",
            details: {
              kind: "app" as const,
              target: "terminal" as const,
              integrity: null,
              rnHostAbi: null,
              provider: null,
            },
          },
          artifacts: [
            {
              path: "index.mjs",
              role: "primary",
              contentType: "text/javascript; charset=utf-8",
              encoding: "utf8",
              content: "export {};\n",
            },
          ],
        },
      ],
    ]);
    buildSystem.getBuildByKey.mockImplementation(
      (key: string) => (buildByKey.get(key) ?? null) as never
    );
    const currentExecution = registerExecution(buildByKey.get("terminal-key-2") as never);
    const previousExecution = registerExecution(buildByKey.get("terminal-key-1") as never);
    host.registry.upsert({
      unitKind: "app",
      name: graphNode.name,
      version: "1.0.0",
      target: "terminal",
      capabilities: ["clipboard"],
      source: { kind: "workspace-repo", repo: graphNode.relativePath, ref: "main" },
      installedAt: Date.now(),
      activeSourceDigest: "sourceDigest-terminal-2",
      activeExecutionDigest: currentExecution.binding.artifact.executionDigest,
      activeSourceHash: "sha-2",
      activeBundleKey: "terminal-key-2",
      activeDependencySourceDigests: {},
      activeExternalDeps: {},
      activeRuntimeDepsKey: null,
      status: "available",
      lastError: null,
      previousVersions: [
        {
          version: "1.0.0",
          target: "terminal",
          capabilities: ["clipboard"],
          activeSourceDigest: "sourceDigest-terminal-1",
          activeExecutionDigest: previousExecution.binding.artifact.executionDigest,
          activeSourceHash: "sha-1",
          activeBundleKey: "terminal-key-1",
          activeDependencySourceDigests: {},
          activeExternalDeps: {},
          activeRuntimeDepsKey: null,
          activatedAt: Date.now() - 1000,
        },
      ],
    });

    await host.rollbackAppVersion(graphNode.name);

    expect(host.registry.get(graphNode.name)).toMatchObject({
      target: "terminal",
      status: "available",
      activeBundleKey: "terminal-key-1",
      activeSourceDigest: "sourceDigest-terminal-1",
      previousVersions: [
        expect.objectContaining({
          activeBundleKey: "terminal-key-2",
          activeSourceDigest: "sourceDigest-terminal-2",
        }),
      ],
    });
    expect(eventService.emit).toHaveBeenCalledWith(
      "apps:lifecycle",
      expect.objectContaining({
        type: "rolled-back",
        appId: graphNode.name,
        target: "terminal",
        buildKey: "terminal-key-1",
        adoptionPolicy: "immediate",
      })
    );
    expect(notificationService.show).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Terminal app update available",
        actions: expect.arrayContaining([
          expect.objectContaining({
            command: { type: "workspace.restartUnit", name: graphNode.name },
          }),
        ]),
      })
    );
  });

  it("still prompts for exact product-seeded app source", async () => {
    const { host, buildSystem, eventService, approvalQueue } = makeHarness({ seeded: true });

    await host.reconcileDeclared([{ source: "apps/shell", ref: "main" }]);
    await host.whenSettled();

    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "unit-batch",
        trigger: "startup",
        units: [
          expect.objectContaining({
            unitKind: "app",
            unitName: "@workspace-apps/shell",
            source: { kind: "workspace-repo", repo: "apps/shell", ref: "main" },
          }),
        ],
      })
    );
    expect(buildSystem.getBuild).toHaveBeenCalledWith("@workspace-apps/shell", "main");
    expect(host.registry.get("@workspace-apps/shell")).toMatchObject({
      unitKind: "app",
      activeBundleKey: "app-key",
      status: "running",
    });
    expect(eventService.emit).toHaveBeenCalledWith(
      "apps:available",
      expect.objectContaining({
        appId: "@workspace-apps/shell",
      })
    );
  });

  it("previews and applies React Native provider changes from trusted main", async () => {
    const { host, buildSystem, eventService, approvalQueue, graphNode } = makeHarness({
      readWorkspaceFileAtCommit: async () => "apps:\n  - source: apps/shell\n",
      reactNativeAppArtifactBaseUrl: "https://mobile.gateway.test",
    });
    setAppManifestTarget(graphNode, "react-native", ["notifications"]);
    installApp(host, graphNode);
    host.registry.patch(graphNode.name, {
      target: "react-native",
      activeExternalDeps: {
        "build-provider:@workspace-extensions/react-native":
          "sourceDigest-provider-old:provider-build-old:vibestudio-build-provider-v1",
      },
    });
    const provider = {
      name: "@workspace-extensions/react-native",
      activeSourceDigest: "sourceDigest-provider-new",
      activeBuildKey: "provider-build-new",
      contractVersion: "vibestudio-build-provider-v1",
    };
    buildSystem.getBuildProviderDetails.mockReturnValue(provider);
    const approval = await host.metaChangeApprovalForCommit("state:provider-change");
    expect(approval.units).toEqual([
      expect.objectContaining({
        unitKind: "app",
        target: "react-native",
        provider,
        externalDeps: expect.objectContaining({
          "build-provider:@workspace-extensions/react-native":
            "sourceDigest-provider-new:provider-build-new:vibestudio-build-provider-v1",
        }),
      }),
    ]);

    const rnBuild = {
      dir: path.join(path.dirname(graphNode.path), "..", "..", "state", "builds", "rn-app-key"),
      metadata: {
        sourceDigest: APP_SOURCE,
        sourceStateHash: "state:test",
        details: {
          kind: "app",
          target: "react-native",
          integrity: "sha256-rn-app",
          rnHostAbi: "rn-host-2",
          provider,
        },
      },
      artifacts: [
        {
          path: "index.android.bundle",
          role: "primary",
          contentType: "application/javascript; charset=utf-8",
          encoding: "utf8",
          platform: "android",
          integrity: "sha256-android",
          content: "android bundle",
        },
        {
          path: "index.ios.bundle",
          role: "primary",
          contentType: "application/javascript; charset=utf-8",
          encoding: "utf8",
          platform: "ios",
          integrity: "sha256-ios",
          content: "ios bundle",
        },
      ],
    };
    buildSystem.getBuild.mockResolvedValueOnce(rnBuild as never);
    buildSystem.getBuildByKey.mockImplementation((key: string) =>
      key === "rn-app-key" ? (rnBuild as never) : null
    );

    await host.reconcileDeclared([
      {
        source: graphNode.relativePath,
        ref: "main",
      },
    ]);
    await host.whenSettled();

    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "unit-batch",
        trigger: "startup",
        units: [
          expect.objectContaining({
            unitKind: "app",
            unitName: graphNode.name,
            target: "react-native",
            provider: expect.objectContaining({
              activeBuildKey: "provider-build-new",
            }),
          }),
        ],
      })
    );
    expect(host.registry.get(graphNode.name)).toMatchObject({
      target: "react-native",
      activeBundleKey: "rn-app-key",
      activeExternalDeps: {
        "build-provider:@workspace-extensions/react-native":
          "sourceDigest-provider-new:provider-build-new:vibestudio-build-provider-v1",
      },
    });
    expect(eventService.emit).toHaveBeenCalledWith(
      "apps:available",
      expect.objectContaining({
        target: "react-native",
        url: "https://mobile.gateway.test/_a/rn-app-key/index.android.bundle",
        artifactRoute: "/_a/rn-app-key/index.android.bundle",
        integrity: "sha256-rn-app",
        rnHostAbi: "rn-host-2",
        provider,
        artifacts: expect.arrayContaining([
          expect.objectContaining({
            path: "index.android.bundle",
            role: "primary",
            platform: "android",
            integrity: "sha256-android",
            route: "/_a/rn-app-key/index.android.bundle",
            url: "https://mobile.gateway.test/_a/rn-app-key/index.android.bundle",
          }),
          expect.objectContaining({
            path: "index.ios.bundle",
            role: "primary",
            platform: "ios",
            integrity: "sha256-ios",
            route: "/_a/rn-app-key/index.ios.bundle",
            url: "https://mobile.gateway.test/_a/rn-app-key/index.ios.bundle",
          }),
        ]),
      })
    );
    expect(host.reactNative.getBootstrap(graphNode.relativePath)).toMatchObject({
      appId: "@workspace-apps/shell",
      buildKey: "rn-app-key",
      capabilities: ["notifications"],
      rnHostAbi: "rn-host-2",
      integrity: "sha256-rn-app",
      artifacts: expect.arrayContaining([
        expect.objectContaining({
          path: "index.android.bundle",
          platform: "android",
          integrity: "sha256-android",
          route: "/_a/rn-app-key/index.android.bundle",
          url: "https://mobile.gateway.test/_a/rn-app-key/index.android.bundle",
        }),
        expect.objectContaining({
          path: "index.ios.bundle",
          platform: "ios",
          integrity: "sha256-ios",
          route: "/_a/rn-app-key/index.ios.bundle",
          url: "https://mobile.gateway.test/_a/rn-app-key/index.ios.bundle",
        }),
      ]),
      provider,
    });
  });

  it("defers trusted React Native provider changes until mobile readiness is requested", async () => {
    const { host, buildSystem, approvalQueue, graphNode, providerChangeCallbacks } = makeHarness({
      readWorkspaceFileAtCommit: async () => "apps:\n  - source: apps/shell\n",
    });
    setAppManifestTarget(graphNode, "react-native", ["notifications"]);
    installApp(host, graphNode);
    host.registry.patch(graphNode.name, {
      target: "react-native",
      activeExternalDeps: {
        "build-provider:@workspace-extensions/react-native":
          "sourceDigest-provider-old:provider-build-old:vibestudio-build-provider-v1",
      },
    });
    const oldProvider = {
      name: "@workspace-extensions/react-native",
      activeSourceDigest: "sourceDigest-provider-old",
      activeBuildKey: "provider-build-old",
      contractVersion: "vibestudio-build-provider-v1",
    };
    const newProvider = {
      name: "@workspace-extensions/react-native",
      activeSourceDigest: "sourceDigest-provider-new",
      activeBuildKey: "provider-build-new",
      contractVersion: "vibestudio-build-provider-v1",
    };
    buildSystem.getBuildProviderDetails.mockReturnValue(oldProvider);
    const declaration = {
      source: graphNode.relativePath,
      ref: "main",
    };

    host.setDeclared([declaration]);
    await host.whenSettled();
    expect(approvalQueue.request).not.toHaveBeenCalled();

    approvalQueue.request.mockClear();
    buildSystem.getBuild.mockClear();
    buildSystem.getBuildProviderDetails.mockReturnValue(newProvider);

    providerChangeCallbacks[0]?.({
      type: "registered",
      target: "react-native",
      provider: newProvider,
    });
    await flushAsyncWork();
    await host.whenSettled();

    expect(approvalQueue.request).not.toHaveBeenCalled();
    expect(buildSystem.getBuild).not.toHaveBeenCalled();
    expect(host.registry.get(graphNode.name)?.activeBundleKey).toBe("app-key");
    const approval = await host.metaChangeApprovalForCommit("state:provider-change");
    expect(approval.units).toEqual([
      expect.objectContaining({
        provider: newProvider,
        externalDeps: expect.objectContaining({
          "build-provider:@workspace-extensions/react-native":
            "sourceDigest-provider-new:provider-build-new:vibestudio-build-provider-v1",
        }),
      }),
    ]);

    const providerChangeBuild = {
      dir: path.join(
        path.dirname(graphNode.path),
        "..",
        "..",
        "state",
        "builds",
        "rn-provider-change-key"
      ),
      metadata: {
        sourceDigest: APP_SOURCE,
        sourceStateHash: "state:test",
        details: {
          kind: "app",
          target: "react-native",
          integrity: "sha256-rn-app",
          rnHostAbi: "rn-host-2",
          provider: newProvider,
        },
      },
      artifacts: [
        {
          path: "index.android.bundle",
          role: "primary",
          contentType: "application/javascript; charset=utf-8",
          encoding: "utf8",
          platform: "android",
          integrity: "sha256-android",
          content: "android bundle",
        },
        {
          path: "index.ios.bundle",
          role: "primary",
          contentType: "application/javascript; charset=utf-8",
          encoding: "utf8",
          platform: "ios",
          integrity: "sha256-ios",
          content: "ios bundle",
        },
      ],
    };
    buildSystem.getBuild.mockResolvedValueOnce(providerChangeBuild as never);
    buildSystem.getBuildByKey.mockImplementation((key: string) =>
      key === "rn-provider-change-key" ? (providerChangeBuild as never) : null
    );

    const readiness = await host.reactNative.ensureReady(graphNode.relativePath);

    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "unit-batch",
        trigger: "startup",
        units: [
          expect.objectContaining({
            unitKind: "app",
            unitName: graphNode.name,
            target: "react-native",
            provider: expect.objectContaining({
              activeBuildKey: "provider-build-new",
            }),
          }),
        ],
      })
    );
    expect(readiness).toMatchObject({
      ready: true,
      source: graphNode.relativePath,
      appId: graphNode.name,
      buildKey: "rn-provider-change-key",
    });
    expect(host.registry.get(graphNode.name)?.activeBundleKey).toBe("rn-provider-change-key");
  });

  it("stages React Native app approval before the provider is active and consumes it after provider startup", async () => {
    const { host, buildSystem, approvalQueue, approvalCoordinator, graphNode } = makeHarness({
      useApprovalCoordinator: true,
    });
    setAppManifestTarget(graphNode, "react-native", ["notifications"]);
    host.setDeclared([{ source: graphNode.relativePath, ref: "main" }]);

    const waitingForProvider = await host.reactNative.ensureReady(null, { waitForApproval: false });

    expect(waitingForProvider).toMatchObject({
      ready: false,
      source: graphNode.relativePath,
      appId: graphNode.name,
      reason: "React Native build provider is not active",
    });
    expect(buildSystem.getBuild).not.toHaveBeenCalled();
    expect(approvalQueue.request).not.toHaveBeenCalled();

    approvalCoordinator?.publishPending("startup");
    await flushAsyncWork();
    await flushAsyncWork();

    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "unit-batch",
        trigger: "startup",
        units: [
          expect.objectContaining({
            unitKind: "app",
            unitName: graphNode.name,
            target: "react-native",
          }),
        ],
      })
    );

    approvalQueue.request.mockClear();

    const provider = {
      name: "@workspace-extensions/react-native",
      activeSourceDigest: "sourceDigest-provider",
      activeBuildKey: "provider-build",
      contractVersion: "vibestudio-build-provider-v1",
    };
    const rnBuild = {
      dir: path.join(
        path.dirname(graphNode.path),
        "..",
        "..",
        "state",
        "builds",
        "rn-preflight-key"
      ),
      metadata: {
        sourceDigest: APP_SOURCE,
        sourceStateHash: "state:test",
        details: {
          kind: "app",
          target: "react-native",
          integrity: "sha256-rn-app",
          rnHostAbi: "rn-host-2",
          provider,
        },
      },
      artifacts: [
        {
          path: "index.android.bundle",
          role: "primary",
          contentType: "application/javascript; charset=utf-8",
          encoding: "utf8",
          platform: "android",
          integrity: "sha256-android",
          content: "android bundle",
        },
      ],
    };
    buildSystem.getBuildProviderDetails.mockReturnValue(provider);
    buildSystem.getBuild.mockResolvedValueOnce(rnBuild as never);
    buildSystem.getBuildByKey.mockImplementation((key: string) =>
      key === "rn-preflight-key" ? (rnBuild as never) : null
    );

    const readiness = await host.reactNative.ensureReady();

    expect(approvalQueue.request).not.toHaveBeenCalled();
    expect(readiness).toMatchObject({
      ready: true,
      source: graphNode.relativePath,
      appId: graphNode.name,
      buildKey: "rn-preflight-key",
    });
    expect(host.registry.get(graphNode.name)).toMatchObject({
      status: "running",
      activeBundleKey: "rn-preflight-key",
    });
  });

  it("does not restage React Native approval for an unchanged trusted app while provider starts", async () => {
    const { host, buildSystem, approvalQueue, approvalCoordinator, graphNode } = makeHarness({
      useApprovalCoordinator: true,
    });
    setAppManifestTarget(graphNode, "react-native", ["notifications"]);
    const provider = {
      name: "@workspace-extensions/react-native",
      activeSourceDigest: "sourceDigest-provider",
      activeBuildKey: "provider-build",
      contractVersion: "vibestudio-build-provider-v1",
    };
    const providerDep = {
      [`build-provider:${provider.name}`]:
        "sourceDigest-provider:provider-build:vibestudio-build-provider-v1",
    };
    installAppEntry(host, graphNode, {
      target: "react-native",
      activeBundleKey: "rn-existing-key",
      activeSourceDigest: APP_SOURCE,
      capabilities: ["notifications"],
    });
    host.registry.patch(graphNode.name, { activeExternalDeps: providerDep });
    const rnBuild = {
      dir: path.join(
        path.dirname(graphNode.path),
        "..",
        "..",
        "state",
        "builds",
        "rn-existing-key"
      ),
      metadata: {
        sourceDigest: APP_SOURCE,
        sourceStateHash: "state:test",
        details: {
          kind: "app",
          target: "react-native",
          integrity: "sha256-rn-app",
          rnHostAbi: "rn-host-2",
          provider,
        },
      },
      artifacts: [
        {
          path: "index.android.bundle",
          role: "primary",
          contentType: "application/javascript; charset=utf-8",
          encoding: "utf8",
          platform: "android",
          integrity: "sha256-android",
          content: "android bundle",
        },
      ],
    };
    buildSystem.getBuildByKey.mockImplementation((key: string) =>
      key === "rn-existing-key" ? (rnBuild as never) : null
    );
    buildSystem.getBuildProviderDetails.mockReturnValue(null);

    await host.reconcileDeclared([{ source: graphNode.relativePath, ref: "main" }]);
    await host.whenSettled();
    approvalCoordinator?.publishPending("startup");
    await flushAsyncWork();

    expect(approvalQueue.request).not.toHaveBeenCalled();
    expect(buildSystem.getBuild).not.toHaveBeenCalled();
    expect(host.registry.get(graphNode.name)).toMatchObject({
      status: "running",
      activeBundleKey: "rn-existing-key",
      activeExternalDeps: providerDep,
    });
  });

  it("defers React Native builds cleanly until the provider starts", async () => {
    const { host, buildSystem, graphNode } = makeHarness();
    setAppManifestTarget(graphNode, "react-native", ["notifications"]);

    await host.reconcileDeclared([{ source: graphNode.relativePath, ref: "main" }]);
    await host.whenSettled();
    expect(host.registry.get(graphNode.name)).toMatchObject({
      status: "stopped",
      lastError: null,
    });
    expect(buildSystem.getBuild).not.toHaveBeenCalled();

    const provider = {
      name: "@workspace-extensions/react-native",
      activeSourceDigest: "sourceDigest-provider",
      activeBuildKey: "provider-build",
      contractVersion: "vibestudio-build-provider-v1",
    };
    const rnBuild = {
      dir: path.join(path.dirname(graphNode.path), "..", "..", "state", "builds", "rn-ready-key"),
      metadata: {
        sourceDigest: APP_SOURCE,
        sourceStateHash: "state:test",
        details: {
          kind: "app",
          target: "react-native",
          integrity: "sha256-rn-app",
          rnHostAbi: "rn-host-2",
          provider,
        },
      },
      artifacts: [
        {
          path: "index.android.bundle",
          role: "primary",
          contentType: "application/javascript; charset=utf-8",
          encoding: "utf8",
          platform: "android",
          integrity: "sha256-android",
          content: "android bundle",
        },
      ],
    };
    buildSystem.getBuildProviderDetails.mockReturnValue(provider);
    buildSystem.getBuild.mockResolvedValueOnce(rnBuild as never);
    buildSystem.getBuildByKey.mockImplementation((key: string) =>
      key === "rn-ready-key" ? (rnBuild as never) : null
    );

    const readiness = await host.reactNative.ensureReady();

    expect(readiness).toMatchObject({
      ready: true,
      source: graphNode.relativePath,
      appId: graphNode.name,
      buildKey: "rn-ready-key",
    });
    expect(host.registry.get(graphNode.name)).toMatchObject({
      status: "running",
      activeBundleKey: "rn-ready-key",
    });
  });

  it("recovers deferred React Native readiness once the provider build is available", async () => {
    const { host, buildSystem, graphNode } = makeHarness();
    setAppManifestTarget(graphNode, "react-native", ["notifications"]);

    await host.reconcileDeclared([{ source: graphNode.relativePath, ref: "main" }]);
    await host.whenSettled();
    expect(host.registry.get(graphNode.name)).toMatchObject({
      status: "stopped",
      lastError: null,
    });
    expect(buildSystem.getBuild).not.toHaveBeenCalled();

    const provider = {
      name: "@workspace-extensions/react-native",
      activeSourceDigest: "sourceDigest-provider",
      activeBuildKey: "provider-build",
      contractVersion: "vibestudio-build-provider-v1",
    };
    const rnBuild = {
      dir: path.join(path.dirname(graphNode.path), "..", "..", "state", "builds", "rn-delayed-key"),
      metadata: {
        sourceDigest: APP_SOURCE,
        sourceStateHash: "state:test",
        details: {
          kind: "app",
          target: "react-native",
          integrity: "sha256-rn-app",
          rnHostAbi: "rn-host-2",
          provider,
        },
      },
      artifacts: [
        {
          path: "index.android.bundle",
          role: "primary",
          contentType: "application/javascript; charset=utf-8",
          encoding: "utf8",
          platform: "android",
          integrity: "sha256-android",
          content: "android bundle",
        },
      ],
    };
    buildSystem.getBuildProviderDetails.mockReturnValue(provider);
    buildSystem.getBuild.mockResolvedValueOnce(rnBuild as never);
    buildSystem.getBuildByKey.mockImplementation((key: string) =>
      key === "rn-delayed-key" ? (rnBuild as never) : null
    );

    const readiness = await host.reactNative.ensureReady();

    expect(readiness).toMatchObject({
      ready: true,
      source: graphNode.relativePath,
      appId: graphNode.name,
      buildKey: "rn-delayed-key",
    });
  });

  it("does not produce React Native bootstrap for platformless primary artifacts", async () => {
    const { host, buildSystem, graphNode } = makeHarness();
    installApp(host, graphNode);
    host.registry.patch(graphNode.name, {
      target: "react-native",
      source: { kind: "workspace-repo", repo: "apps/mobile", ref: "main" },
      activeSourceDigest: "sourceDigest-mobile",
      activeBundleKey: "rn-platformless-key",
      capabilities: ["notifications"],
    });
    buildSystem.getBuildByKey.mockImplementation((key: string) =>
      key === "rn-platformless-key"
        ? ({
            dir: path.join(
              path.dirname(graphNode.path),
              "..",
              "..",
              "state",
              "builds",
              "rn-platformless-key"
            ),
            metadata: {
              sourceDigest: "sourceDigest-mobile",
              sourceStateHash: "state:test",
              details: {
                kind: "app",
                target: "react-native",
                integrity: "sha256-rn-app",
                rnHostAbi: "rn-host-2",
                provider: REACT_NATIVE_PROVIDER,
              },
            },
            artifacts: [
              {
                path: "index.bundle",
                role: "primary",
                contentType: "application/javascript; charset=utf-8",
                encoding: "utf8",
                content: "bundle",
              },
            ],
          } as never)
        : null
    );

    expect(host.reactNative.getBootstrap("apps/mobile")).toBeNull();
  });

  it("produces React Native bootstrap for platform-specific mobile builds", async () => {
    const { host, buildSystem, graphNode } = makeHarness({
      reactNativeAppArtifactBaseUrl: "https://host.tailnet.ts.net",
    });
    installApp(host, graphNode);
    host.registry.patch(graphNode.name, {
      target: "react-native",
      source: { kind: "workspace-repo", repo: "apps/mobile", ref: "main" },
      activeSourceDigest: "sourceDigest-mobile",
      activeBundleKey: "rn-android-only-key",
      capabilities: ["notifications"],
    });
    buildSystem.getBuildByKey.mockImplementation((key: string) =>
      key === "rn-android-only-key"
        ? ({
            dir: path.join(
              path.dirname(graphNode.path),
              "..",
              "..",
              "state",
              "builds",
              "rn-android-only-key"
            ),
            metadata: {
              sourceDigest: "sourceDigest-mobile",
              sourceStateHash: "state:test",
              details: {
                kind: "app",
                target: "react-native",
                integrity: "sha256-rn-app",
                rnHostAbi: "rn-host-2",
                provider: REACT_NATIVE_PROVIDER,
              },
            },
            artifacts: [
              {
                path: "index.android.bundle",
                role: "primary",
                contentType: "application/javascript; charset=utf-8",
                encoding: "utf8",
                platform: "android",
                integrity: "sha256-android",
                content: "bundle",
              },
            ],
          } as never)
        : null
    );

    expect(host.reactNative.getBootstrap("apps/mobile")).toMatchObject({
      buildKey: "rn-android-only-key",
      artifacts: [
        expect.objectContaining({
          path: "index.android.bundle",
          platform: "android",
          integrity: "sha256-android",
          route: "/_a/rn-android-only-key/index.android.bundle",
          url: "https://host.tailnet.ts.net/_a/rn-android-only-key/index.android.bundle",
        }),
      ],
    });
  });

  it("does not produce React Native bootstrap without provider identity", async () => {
    const { host, buildSystem, graphNode } = makeHarness();
    installApp(host, graphNode);
    host.registry.patch(graphNode.name, {
      target: "react-native",
      source: { kind: "workspace-repo", repo: "apps/mobile", ref: "main" },
      activeSourceDigest: "sourceDigest-mobile",
      activeBundleKey: "rn-no-provider-key",
      capabilities: ["notifications"],
    });
    buildSystem.getBuildByKey.mockImplementation((key: string) =>
      key === "rn-no-provider-key"
        ? ({
            dir: path.join(
              path.dirname(graphNode.path),
              "..",
              "..",
              "state",
              "builds",
              "rn-no-provider-key"
            ),
            metadata: {
              sourceDigest: "sourceDigest-mobile",
              sourceStateHash: "state:test",
              details: {
                kind: "app",
                target: "react-native",
                integrity: "sha256-rn-app",
                rnHostAbi: "rn-host-2",
                provider: null,
              },
            },
            artifacts: [
              {
                path: "index.android.bundle",
                role: "primary",
                contentType: "application/javascript; charset=utf-8",
                encoding: "utf8",
                platform: "android",
                integrity: "sha256-android",
                content: "android bundle",
              },
              {
                path: "index.ios.bundle",
                role: "primary",
                contentType: "application/javascript; charset=utf-8",
                encoding: "utf8",
                platform: "ios",
                integrity: "sha256-ios",
                content: "ios bundle",
              },
            ],
          } as never)
        : null
    );

    expect(host.reactNative.getBootstrap("apps/mobile")).toBeNull();
  });

  it("fails closed before activating React Native builds without provider identity", async () => {
    const { host, buildSystem, eventService, graphNode } = makeHarness();
    setAppManifestTarget(graphNode, "react-native", ["notifications"]);
    buildSystem.getBuildProviderDetails.mockReturnValue(REACT_NATIVE_PROVIDER);
    const rnBuild = {
      dir: path.join(
        path.dirname(graphNode.path),
        "..",
        "..",
        "state",
        "builds",
        "rn-no-provider-key"
      ),
      metadata: {
        sourceDigest: APP_SOURCE,
        sourceStateHash: "state:test",
        details: {
          kind: "app",
          target: "react-native",
          integrity: "sha256-rn-app",
          rnHostAbi: "rn-host-2",
          provider: null,
        },
      },
      artifacts: [
        {
          path: "index.android.bundle",
          role: "primary",
          contentType: "application/javascript; charset=utf-8",
          encoding: "utf8",
          platform: "android",
          integrity: "sha256-android",
          content: "android bundle",
        },
        {
          path: "index.ios.bundle",
          role: "primary",
          contentType: "application/javascript; charset=utf-8",
          encoding: "utf8",
          platform: "ios",
          integrity: "sha256-ios",
          content: "ios bundle",
        },
      ],
    };
    buildSystem.getBuild.mockResolvedValueOnce(rnBuild as never);

    await host.reconcileDeclared([
      {
        source: graphNode.relativePath,
        ref: "main",
      },
    ]);
    await host.whenSettled();

    expect(host.registry.get(graphNode.name)).toMatchObject({
      status: "error",
      activeBundleKey: null,
      lastError: expect.stringContaining("provider identity"),
    });
    expect(eventService.emit).not.toHaveBeenCalledWith(
      "apps:available",
      expect.objectContaining({ target: "react-native" })
    );
  });

  it("fails closed before activating React Native builds without platform-keyed primary artifacts", async () => {
    const { host, buildSystem, eventService, graphNode } = makeHarness();
    setAppManifestTarget(graphNode, "react-native", ["notifications"]);
    buildSystem.getBuildProviderDetails.mockReturnValue(REACT_NATIVE_PROVIDER);
    const rnBuild = {
      dir: path.join(path.dirname(graphNode.path), "..", "..", "state", "builds", "rn-bad-key"),
      metadata: {
        sourceDigest: APP_SOURCE,
        sourceStateHash: "state:test",
        details: {
          kind: "app",
          target: "react-native",
          integrity: "sha256-rn-app",
          rnHostAbi: "rn-host-2",
          provider: REACT_NATIVE_PROVIDER,
        },
      },
      artifacts: [
        {
          path: "index.bundle",
          role: "primary",
          contentType: "application/javascript; charset=utf-8",
          encoding: "utf8",
          content: "bundle",
        },
      ],
    };
    buildSystem.getBuild.mockResolvedValueOnce(rnBuild as never);

    await host.reconcileDeclared([
      {
        source: graphNode.relativePath,
        ref: "main",
      },
    ]);
    await host.whenSettled();

    expect(host.registry.get(graphNode.name)).toMatchObject({
      status: "error",
      activeBundleKey: null,
      lastError: expect.stringContaining("missing a mobile platform"),
    });
    expect(eventService.emit).not.toHaveBeenCalledWith(
      "apps:available",
      expect.objectContaining({ target: "react-native" })
    );
  });

  it("activates React Native builds with a single platform primary artifact", async () => {
    const { host, buildSystem, graphNode } = makeHarness();
    setAppManifestTarget(graphNode, "react-native", ["notifications"]);
    buildSystem.getBuildProviderDetails.mockReturnValue(REACT_NATIVE_PROVIDER);
    const rnBuild = {
      dir: path.join(
        path.dirname(graphNode.path),
        "..",
        "..",
        "state",
        "builds",
        "rn-android-only-key"
      ),
      metadata: {
        sourceDigest: APP_SOURCE,
        sourceStateHash: "state:test",
        details: {
          kind: "app",
          target: "react-native",
          integrity: "sha256-rn-app",
          rnHostAbi: "rn-host-2",
          provider: REACT_NATIVE_PROVIDER,
        },
      },
      artifacts: [
        {
          path: "index.android.bundle",
          role: "primary",
          contentType: "application/javascript; charset=utf-8",
          encoding: "utf8",
          platform: "android",
          integrity: "sha256-android",
          content: "bundle",
        },
      ],
    };
    buildSystem.getBuild.mockResolvedValueOnce(rnBuild as never);

    await host.reconcileDeclared([
      {
        source: graphNode.relativePath,
        ref: "main",
      },
    ]);
    await host.whenSettled();

    expect(host.registry.get(graphNode.name)).toMatchObject({
      status: "running",
      activeBundleKey: "rn-android-only-key",
      lastError: null,
    });
  });

  it("fails closed when a trusted app manifest drifts to native fields", async () => {
    const { host, buildSystem, eventService, approvalQueue } = makeHarness({
      invalidManifest: true,
    });

    await host.reconcileDeclared([{ source: "apps/shell", ref: "main" }]);
    await host.whenSettled();

    expect(approvalQueue.request).not.toHaveBeenCalled();
    expect(buildSystem.getBuild).not.toHaveBeenCalled();
    expect(host.registry.get("@workspace-apps/shell")).toBeNull();
    expect(eventService.emit).toHaveBeenCalledWith(
      "apps:status",
      expect.objectContaining({
        name: "@workspace-apps/shell",
        status: "error",
        error: expect.stringContaining("pure-thin"),
      })
    );
  });

  it("stores a four-hour dev-session grant for app main pushes", async () => {
    const { host, approvalQueue, graphNode } = makeHarness({ approvalDecision: "session" });
    installApp(host, graphNode);
    const request = {
      caller: panelCaller("panel-1"),
      repoPath: graphNode.relativePath,
      branch: "main",
      commit: "def456",
    };

    await expect(host.authorizeSourceChange(request)).resolves.toEqual({ allowed: true });
    await expect(host.authorizeSourceChange({ ...request, commit: "def457" })).resolves.toEqual({
      allowed: true,
    });
    await expect(
      host.authorizeSourceChange({
        ...request,
        caller: panelCaller("panel-2"),
        commit: "def458",
      })
    ).resolves.toEqual({ allowed: true });

    expect(approvalQueue.request).toHaveBeenCalledTimes(2);
    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "unit-batch",
        callerId: "panel-1",
        callerKind: "panel",
        repoPath: "panels/test",
        executionDigest: "sourceDigest-panel",
        trigger: "source-change",
        title: "@workspace-apps/shell app source change",
        units: [
          expect.objectContaining({
            unitKind: "app",
            unitName: "@workspace-apps/shell",
            sourceDigest: APP_SOURCE,
            source: expect.objectContaining({ repo: graphNode.relativePath, ref: "main" }),
          }),
        ],
      })
    );
  });

  it("does not gate unknown app repos or non-active branches", async () => {
    const { host, approvalQueue, graphNode } = makeHarness();
    installApp(host, graphNode);

    await expect(
      host.authorizeSourceChange({
        caller: panelCaller(),
        repoPath: "apps/unknown",
        branch: "main",
        commit: "def456",
      })
    ).resolves.toEqual({ allowed: true });
    await expect(
      host.authorizeSourceChange({
        caller: panelCaller(),
        repoPath: graphNode.relativePath,
        branch: "feature",
        commit: "def456",
      })
    ).resolves.toEqual({ allowed: true });

    expect(approvalQueue.request).not.toHaveBeenCalled();
  });
});

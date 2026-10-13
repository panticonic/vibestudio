import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ledgerTest } from "../../tests/helpers/ledgerTest.js";

import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import {
  buildHostBuildUnitInventory,
  hostBuildUnitInventoryPath,
} from "@vibestudio/shared/hostBuildUnits";
import { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import { ConnectionGrantService } from "@vibestudio/shared/connectionGrants";
import type { PendingApproval } from "@vibestudio/shared/approvals";
import type { ProtectedPublicationEvent } from "@vibestudio/shared/protectedPublicationEvents";
import { WORKSPACE_SYSTEM_EPOCH } from "@vibestudio/shared/vcs/systemEpoch";
import { canonicalJson } from "@vibestudio/content-addressing";
import { domainHash } from "@vibestudio/shared/execution/identity";
import {
  executionArtifactDigest,
  executionSourceClosureDigest,
} from "@vibestudio/shared/execution/retention";
import { AppHost, type AppHostDeps } from "./appHost.js";
import { RuntimeDiagnosticsStore } from "./runtimeDiagnosticsStore.js";
import { UnitInstallReviewCoordinator } from "./unitInstallReviewCoordinator.js";
import type { BuildArtifactManifestEntry, BuildMetadata } from "./buildV2/buildStore.js";

const roots: string[] = [];
const ownedHosts = new Set<AppHost>();
const originalAppDevStatus = process.env["VIBESTUDIO_APP_DEV_STATUS"];
const REACT_NATIVE_PROVIDER = {
  name: "@workspace-extensions/react-native",
  activeEv: "ev-provider",
  activeBuildKey: "provider-build",
  contractVersion: "vibestudio-build-provider-v1",
};
const TEST_EXECUTION_IDENTITY: NonNullable<BuildMetadata["execution"]> = {
  version: 1,
  sourceState: {
    kind: "workspace",
    workspaceId: "workspace:test",
    effectiveVersion: "b".repeat(64) as never,
    state: { kind: "event", eventId: "event:test" },
    contentRoots: [{ repoPath: "apps/shell", stateHash: `state:${"e".repeat(64)}` }],
    sourceClosureDigest: "f".repeat(64) as never,
  },
  recipeDigest: "c".repeat(64) as never,
  buildKey: "c".repeat(64) as never,
  artifactDigest: "d".repeat(64) as never,
  executionDigest: "a".repeat(64) as never,
};
const TEST_SEALED_APP_BUILD_METADATA = {
  kind: "app",
  name: "@workspace-apps/shell",
  buildKey: "app-key",
  sourcePath: null,
  ev: "ev-app",
  sourceStateHash: "state:test",
  sourcemap: false,
  builtAt: "2026-10-12T00:00:00.000Z",
  details: { kind: "app", target: "electron", integrity: "sha256-app" },
  execution: TEST_EXECUTION_IDENTITY,
  authority: { requests: [], provides: [] },
} satisfies BuildMetadata;

function publicationEvent(): ProtectedPublicationEvent {
  return {
    publicationId: "publication:test",
    resultHostRefsBasisDigest: "host-refs:test",
    appliedAt: 42,
    workspaceStateHash: "state:published",
    changedPaths: ["apps/shell/index.tsx"],
    repositories: [
      {
        repoPath: "apps/shell",
        previousStateHash: "state:previous",
        nextStateHash: "state:next",
        fileChanges: [],
      },
    ],
  };
}

afterEach(async () => {
  const retirement = await Promise.allSettled([...ownedHosts].map((host) => host.shutdown()));
  ownedHosts.clear();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  if (originalAppDevStatus === undefined) delete process.env["VIBESTUDIO_APP_DEV_STATUS"];
  else process.env["VIBESTUDIO_APP_DEV_STATUS"] = originalAppDevStatus;
  const failures = retirement.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : []
  );
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "AppHost fixture retirement failed");
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-app-host-"));
  roots.push(root);
  return root;
}

function storedArtifact(
  dir: string,
  artifactPath: string,
  body: Buffer | string,
  fields: Pick<BuildArtifactManifestEntry, "role" | "contentType" | "encoding"> &
    Partial<Pick<BuildArtifactManifestEntry, "platform">>
): BuildArtifactManifestEntry {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  fs.mkdirSync(path.dirname(path.join(dir, artifactPath)), { recursive: true });
  fs.writeFileSync(path.join(dir, artifactPath), bytes);
  return {
    path: artifactPath,
    ...fields,
    byteLength: bytes.byteLength,
    integrity: `sha256-${createHash("sha256").update(bytes).digest("hex")}`,
  };
}

async function makeHarness(
  opts: {
    root?: string;
    isAdmitted?: AppHostDeps["isAdmitted"];
    openUnitReviewFor?: AppHostDeps["openUnitReviewFor"];
    seeded?: boolean;
    invalidManifest?: boolean;
    approvalDecision?: "accepted" | "deny";
    useApprovalCoordinator?: boolean;
    readWorkspaceFileAtState?: (stateHash: string, filePath: string) => Promise<string | null>;
    reactNativeAppArtifactBaseUrl?: string;
    terminalAppArtifactBaseUrl?: string;
    affectedBuildUnits?: string[];
    isSystemWorkspace?: () => boolean;
    getWorkspaceTrustGrants?: AppHostDeps["getWorkspaceTrustGrants"];
    prepareHostTarget?: AppHostDeps["prepareHostTarget"];
    beforeInitialize?: (
      host: AppHost,
      getBuildByKey: AppHostDeps["buildSystem"]["getBuildByKey"]
    ) => void | Promise<void>;
  } = {}
) {
  const root = opts.root ?? tempRoot();
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
        icon: "🖥️",
        app: {
          target: "electron",
          renderer: "index.tsx",
          capabilities: ["notifications"],
          ...(opts.invalidManifest ? { preload: "preload.ts" } : {}),
        },
        authority: { requests: [], provides: [] },
      },
    })
  );
  fs.writeFileSync(path.join(appPath, "index.tsx"), "export default null;\n");
  if (opts.seeded) {
    // The host records what a designated template shipped, in host state. Only
    // apps/shell is recorded here, matching the one unit this harness lays down
    // as shipped source.
    const inventoryPath = hostBuildUnitInventoryPath(path.join(root, "state"));
    fs.mkdirSync(path.dirname(inventoryPath), { recursive: true });
    fs.writeFileSync(
      inventoryPath,
      JSON.stringify(
        buildHostBuildUnitInventory({
          root: workspacePath,
          unitRepoPaths: ["apps/shell"],
          templateUrl: "git+https://example.test/base.git",
          commit: "a".repeat(40),
        })
      )
    );
  }
  const defaultBuildDir = path.join(root, "state", "builds", "app-key");
  const artifact = storedArtifact(defaultBuildDir, "index.html", "<!doctype html><div>app</div>", {
    role: "html",
    contentType: "text/html; charset=utf-8",
    encoding: "utf8",
  });
  const graphNode = {
    name: "@workspace-apps/shell",
    kind: "app",
    relativePath: "apps/shell",
    path: appPath,
    internalDeps: [],
    manifest: {
      displayName: "Shell App",
      icon: "🖥️",
      app: { target: "electron" as const, capabilities: ["notifications" as const] },
    },
  };
  const providerChangeCallbacks: Array<
    (event: {
      type: "registered" | "unregistered";
      target: "react-native";
      provider: {
        name: string;
        activeEv: string | null;
        activeBuildKey: string | null;
        contractVersion: string;
      };
    }) => void
  > = [];
  const buildSystem = {
    getStoredBuild: vi.fn<AppHostDeps["buildSystem"]["getStoredBuild"]>(async () => ({
      dir: defaultBuildDir,
      buildKey: "app-key",
      sourceStateHash: "state:test",
      metadata: {
        ...TEST_SEALED_APP_BUILD_METADATA,
        ev: "ev-app",
        sourceStateHash: "state:test",
        execution: TEST_EXECUTION_IDENTITY,
        authority: { requests: [], provides: [] },
        details: { kind: "app", target: "electron", integrity: "sha256-app" },
        buildKey: "app-key",
      },
      artifacts: [artifact],
    })),
    getBuildByKey: vi.fn<AppHostDeps["buildSystem"]["getBuildByKey"]>(async (key: string) =>
      key === "app-key"
        ? {
            dir: defaultBuildDir,
            buildKey: key,
            sourceStateHash: "state:test",
            metadata: {
              ...TEST_SEALED_APP_BUILD_METADATA,
              buildKey: key,
              ev: "ev-app",
              sourceStateHash: "state:test",
              execution: TEST_EXECUTION_IDENTITY,
              authority: { requests: [], provides: [] } as NonNullable<BuildMetadata["authority"]>,
              details: { kind: "app", target: "electron", integrity: "sha256-app" },
            },
            artifacts: [artifact],
          }
        : null
    ),
    readBuildArtifactBytes: vi.fn<AppHostDeps["buildSystem"]["readBuildArtifactBytes"]>(
      async (build, entry) => fs.promises.readFile(path.join(build.dir, entry.path))
    ),
    readBuildArtifactContent: vi.fn<AppHostDeps["buildSystem"]["readBuildArtifactContent"]>(
      async (build, entry) => fs.promises.readFile(path.join(build.dir, entry.path), "utf8")
    ),
    getBuildArtifactPath: vi.fn<AppHostDeps["buildSystem"]["getBuildArtifactPath"]>(
      (build, entry) => path.join(build.dir, entry.path)
    ),
    getEffectiveVersion: vi.fn((name: string): string | null =>
      name === "@workspace-apps/shell" ? "ev-app" : null
    ),
    resolveBuildUnitIdentity: vi.fn(async () => ({
      unitPath: "apps/shell",
      unitName: "@workspace-apps/shell",
      stateHash: "state:current",
      manifest: { authority: { requests: [], provides: [] } },
      serviceBindings: [],
      serviceReviews: [],
      effectiveVersion: "ev-app",
      dependencyEvs: {},
      externalDeps: {},
    })),
    listAffectedBuildUnits: vi.fn(async () => opts.affectedBuildUnits ?? [graphNode.name]),
    getExternalDeps: vi.fn(() => ({})),
    getBuildProviderDetails: vi.fn(
      () =>
        null as {
          name: string;
          activeEv: string | null;
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
            activeEv: string | null;
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
    request: vi.fn(async (_req: unknown) => opts.approvalDecision ?? ("accepted" as const)),
    listPending: vi.fn<() => PendingApproval[]>(() => []),
    requestWithHandle: vi.fn((req) => ({
      approvalId: "install-review",
      decision: approvalQueue.request(req),
    })),
  };
  const notificationService = { show: vi.fn(() => "notification-id") };
  const entityCache = new EntityCache();
  const approvalCoordinator = opts.useApprovalCoordinator
    ? new UnitInstallReviewCoordinator({ approvalQueue, delayMs: 10_000 })
    : undefined;
  const statePath = path.join(root, "state");
  const diagnostics = new RuntimeDiagnosticsStore({ statePath });
  const host = new AppHost({
    statePath,
    workspacePath,
    workspaceId: "ws",
    diagnostics,
    isSystemWorkspace: opts.isSystemWorkspace ?? (() => true),
    getWorkspaceTrustGrants:
      opts.getWorkspaceTrustGrants ?? (() => ({ chromeApps: ["apps/shell", "apps/mobile"] })),
    buildSystem,
    isAdmitted: opts.isAdmitted,
    openUnitReviewFor: opts.openUnitReviewFor,
    eventService: eventService as never,
    approvalQueue,
    approvalCoordinator,
    notificationService,
    entityCache,
    readWorkspaceFileAtState: async (stateHash, filePath) =>
      filePath === "apps/shell/package.json"
        ? fs.readFileSync(path.join(appPath, "package.json"), "utf8")
        : ((await opts.readWorkspaceFileAtState?.(stateHash, filePath)) ?? null),
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
          : { appSource: "apps/terminal-browser", requiresExtensions: [] },
    ...(opts.prepareHostTarget ? { prepareHostTarget: opts.prepareHostTarget } : {}),
  });
  ownedHosts.add(host);
  try {
    await opts.beforeInitialize?.(host, buildSystem.getBuildByKey);
    await host.initialize();
  } catch (error) {
    // Failed fixture creation still owns initialization work.
    // Shutdown joins it before the test is allowed to retire its scratch root.
    let cleanupFailure: unknown;
    try {
      await host.shutdown();
    } catch (failure) {
      cleanupFailure = failure;
    }
    ownedHosts.delete(host);
    if (cleanupFailure !== undefined && cleanupFailure !== error) {
      throw new AggregateError(
        [error, cleanupFailure],
        "AppHost fixture initialization and retirement failed"
      );
    }
    throw error;
  }
  return {
    host,
    buildSystem,
    eventService,
    approvalQueue,
    approvalCoordinator,
    notificationService,
    diagnostics,
    graphNode,
    appPath,
    root,
    workspacePath,
    entityCache,
    providerChangeCallbacks,
  };
}

function installApp(
  host: AppHost,
  graphNode: Awaited<ReturnType<typeof makeHarness>>["graphNode"]
): void {
  host.registry.upsert({
    unitKind: "app",
    name: graphNode.name,
    version: "1.0.0",
    target: "electron",
    capabilities: ["notifications"],
    source: { kind: "workspace-repo", repo: graphNode.relativePath, ref: "main" },
    installedAt: Date.now(),
    activeEv: "ev-app",
    activeSourceHash: "abc123",
    activeBundleKey: "app-key",
    activeExecutionDigest: TEST_EXECUTION_IDENTITY.executionDigest,
    activeDependencyEvs: {},
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
          ...(opts.target === "terminal" ? { entry: "index.ts" } : { renderer: "index.tsx" }),
          capabilities: opts.capabilities ?? [],
        },
        authority: { requests: [], provides: [] },
      },
    })
  );
  fs.writeFileSync(
    path.join(appPath, opts.target === "terminal" ? "index.ts" : "index.tsx"),
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
    },
  };
}

function setAppManifestTarget(
  node: Awaited<ReturnType<typeof makeHarness>>["graphNode"],
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
        authority: { requests: [], provides: [] },
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
    activeExecutionDigest?: string;
    activeEv?: string;
    capabilities?: string[];
    previousVersions?: Array<{
      activeBundleKey: string;
      activeEv: string | null;
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
    activeEv: opts.activeEv ?? `ev-${node.name}`,
    activeSourceHash: "abc123",
    activeBundleKey: opts.activeBundleKey ?? `${node.name}-key`,
    activeExecutionDigest: opts.activeExecutionDigest ?? TEST_EXECUTION_IDENTITY.executionDigest,
    activeDependencyEvs: {},
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
      activeEv: version.activeEv,
      activeSourceHash: "previous-sha",
      activeBundleKey: version.activeBundleKey,
      executionDigest: TEST_EXECUTION_IDENTITY.executionDigest,
      activeDependencyEvs: {},
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

describe("AppHost", () => {
  it("requires initialization before synchronous version reads and reuses one initialization flight", async () => {
    await makeHarness({
      beforeInitialize: async (host) => {
        expect(() => host.listAppVersions("apps/shell")).toThrow("must be initialized");
        const initialization = host.initialize();
        expect(host.initialize()).toBe(initialization);
        await initialization;
        expect(host.listAppVersions("apps/shell")).toMatchObject({ current: null, previous: [] });
      },
    });
  });

  it("backfills and persists legacy active and retained execution identities before admission", async () => {
    const first = await makeHarness();
    installApp(first.host, first.graphNode);
    const current = first.host.listAppVersions(first.graphNode.name).current!;
    const { executionDigest: _legacyMissingDigest, ...legacyVersion } = current;
    first.host.registry.patch(first.graphNode.name, {
      activeExecutionDigest: null,
      previousVersions: [legacyVersion] as never,
    });
    await first.host.shutdown();

    const restored = await makeHarness({ root: first.root });
    expect(restored.host.listAppVersions(restored.graphNode.name)).toMatchObject({
      current: { executionDigest: TEST_EXECUTION_IDENTITY.executionDigest },
      previous: [{ executionDigest: TEST_EXECUTION_IDENTITY.executionDigest }],
    });
    expect(restored.buildSystem.getBuildByKey).toHaveBeenCalledWith("app-key");
    expect(restored.buildSystem.getStoredBuild).not.toHaveBeenCalled();
    await restored.host.shutdown();
    const persisted = await makeHarness({ root: first.root });
    expect(persisted.buildSystem.getBuildByKey).not.toHaveBeenCalled();
    await persisted.host.shutdown();
  });

  it("fails closed when a legacy active execution references an unavailable immutable build", async () => {
    const first = await makeHarness();
    installApp(first.host, first.graphNode);
    first.host.registry.patch(first.graphNode.name, {
      activeBundleKey: "missing-build",
      activeExecutionDigest: null,
    });
    await first.host.shutdown();
    await expect(makeHarness({ root: first.root })).rejects.toThrow(
      "unverifiable build missing-build"
    );
  });

  it("joins failed legacy history reads before rejecting initialization without publishing partial identities", async () => {
    const first = await makeHarness();
    installApp(first.host, first.graphNode);
    const current = first.host.listAppVersions(first.graphNode.name).current!;
    const { executionDigest: _missingDigest, ...legacyVersion } = current;
    first.host.registry.patch(first.graphNode.name, {
      previousVersions: [
        { ...legacyVersion, activeBundleKey: "failed-history" },
        { ...legacyVersion, activeBundleKey: "pending-history" },
      ] as never,
    });
    await first.host.shutdown();
    const readFailure = new Error("Retained history lookup failed");
    await expect(
      makeHarness({
        root: first.root,
        beforeInitialize: async (host, lookup) => {
          let release!: () => void;
          let started!: () => void;
          const readStarted = new Promise<void>((resolve) => {
            started = resolve;
          });
          vi.mocked(lookup).mockImplementation(async (key) => {
            if (key === "failed-history") throw readFailure;
            started();
            await new Promise<void>((resolve) => {
              release = resolve;
            });
            return null;
          });
          const patch = vi.spyOn(host.registry, "patch");
          let settled = false;
          const result = host.initialize().catch((error: unknown) => {
            settled = true;
            return error;
          });
          await readStarted;
          await Promise.resolve();
          expect(settled).toBe(false);
          expect(patch).not.toHaveBeenCalled();
          release();
          const failure = (await result) as AggregateError;
          expect(failure.errors).toContain(readFailure);
          expect(failure.errors[1]).toMatchObject({
            message: expect.stringContaining("pending-history"),
          });
          expect(patch).not.toHaveBeenCalled();
        },
      })
    ).rejects.toBeInstanceOf(AggregateError);
  });

  it("reviews resolved service authority from the exact app source", async () => {
    const { host, buildSystem, graphNode } = await makeHarness();
    const candidate = await buildSystem.resolveBuildUnitIdentity();
    const serviceBindings = [
      {
        protocol: "vibestudio.missions.v1",
        availability: "required" as const,
        serviceName: "missions",
        providerUnit: "workers/missions",
        catalogDigest: "b".repeat(64),
      },
    ];
    const serviceReviews = [
      {
        capability: "workspace-service:missions",
        providerUnit: "workers/missions",
        catalogDigest: "b".repeat(64),
        presentation: null,
      },
    ];
    buildSystem.resolveBuildUnitIdentity.mockResolvedValueOnce({
      ...candidate,
      serviceBindings,
      serviceReviews,
    } as never);
    const review = await host.reviewDeclared([{ source: graphNode.relativePath, ref: "main" }]);
    expect(review.units[0]?.authority).toMatchObject({ serviceBindings, serviceReviews });
  });
  it("keeps native app source authorable outside System without staging launch reviews or runtimes", async () => {
    const { host, buildSystem, approvalQueue, graphNode, workspacePath } = await makeHarness({
      isSystemWorkspace: () => false,
      seeded: true,
    });
    const mobile = createAppGraphNode(workspacePath, "apps/mobile", {
      name: "@workspace-apps/mobile",
      target: "react-native",
    });
    const terminal = createAppGraphNode(workspacePath, "apps/terminal-browser", {
      name: "@workspace-apps/terminal-browser",
      target: "terminal",
    });
    const nodes = [graphNode, mobile, terminal];
    buildSystem.getGraph.mockReturnValue({ allNodes: () => nodes } as never);
    const declared = nodes.map((node) => ({ source: node.relativePath, ref: "main" }));
    host.setDeclared(declared);
    expect(await host.reviewDeclared(declared)).toEqual({ units: [], identityKeys: [] });
    expect(await host.seedTrustedDeclared(declared)).toEqual([]);
    await host.reconcileDeclared(declared);
    await host.whenSettled();
    expect((await host.unitChangeApprovalForCommit(`state:${"a".repeat(64)}`)).units).toEqual([]);
    for (const target of ["electron", "react-native", "terminal"] as const)
      expect(await host.listHostTargetCandidates(target)).toEqual([]);
    expect(await host.ensureElectronReady()).toMatchObject({ ready: false });
    expect(await host.reactNative.ensureReady()).toMatchObject({ ready: false });
    expect(approvalQueue.request).not.toHaveBeenCalled();
    expect(buildSystem.getStoredBuild).not.toHaveBeenCalled();
    expect(host.registry.list()).toEqual([]);
    expect(buildSystem.getGraph().allNodes()).toEqual(nodes);
  });

  it.each(["electron", "react-native", "terminal"] as const)(
    "rejects stale %s runtime authority when the protected System designation is absent",
    async (target) => {
      let system = true;
      const { host, graphNode, entityCache } = await makeHarness({
        isSystemWorkspace: () => system,
      });
      installApp(host, graphNode);
      host.registry.patch(graphNode.name, { target });
      expect(host.hasAppCapability(graphNode.name, "notifications")).toBe(true);
      system = false;
      expect(host.hasAppCapability(graphNode.name, "notifications")).toBe(false);
      await expect(host.activateRelease(graphNode.name)).rejects.toThrow(
        "designated System workspace"
      );
      if (target === "react-native")
        await expect(host.reactNative.getBootstrap(graphNode.relativePath)).rejects.toThrow(
          "designated System workspace"
        );
      if (target !== "electron")
        await expect(
          host.registerDevicePrincipal(target, "device-1", graphNode.relativePath)
        ).rejects.toThrow("designated System workspace");
      expect(entityCache.listActive()).toEqual([]);
    }
  );

  it("serves only active builds and builds retained for rollback", async () => {
    const { host, graphNode } = await makeHarness();
    installAppEntry(host, graphNode, {
      activeBundleKey: "app-key",
      activeExecutionDigest: TEST_EXECUTION_IDENTITY.executionDigest,
      previousVersions: [{ activeBundleKey: "app-key-old", activeEv: "ev-old" }],
    });

    await expect(host.servesBuild("app-key")).resolves.toBe(true);
    await expect(host.servesBuild("app-key-old")).resolves.toBe(true);
    await expect(host.servesBuild("unrelated-key")).resolves.toBe(false);
  });

  it("computes meta-change approvals from committed workspace config", async () => {
    const readWorkspaceFileAtState = vi.fn(async (_stateHash: string, filePath: string) =>
      filePath === "meta/vibestudio.yml"
        ? `systemEpoch: ${WORKSPACE_SYSTEM_EPOCH}\napps:\n  - source: apps/shell\n`
        : null
    );
    const { host } = await makeHarness({ readWorkspaceFileAtState });

    const approval = await host.unitChangeApprovalForCommit("state:next");

    expect(readWorkspaceFileAtState).toHaveBeenCalledWith("state:next", "meta/vibestudio.yml");
    expect(approval.units).toEqual([
      expect.objectContaining({
        unitKind: "app",
        unitName: "@workspace-apps/shell",
        source: { kind: "workspace-repo", repo: "apps/shell", ref: "main" },
      }),
    ]);
  });

  it("does not review apps for an unrelated repository publication", async () => {
    const readWorkspaceFileAtState = vi.fn(async (_stateHash: string, filePath: string) =>
      filePath === "meta/vibestudio.yml"
        ? `systemEpoch: ${WORKSPACE_SYSTEM_EPOCH}\napps:\n  - source: apps/shell\n`
        : null
    );
    const { host } = await makeHarness({ readWorkspaceFileAtState, affectedBuildUnits: [] });
    host.setDeclared([{ source: "apps/shell", ref: "main" }]);

    const approval = await host.unitChangeApprovalForCommit("state:next", {
      changedPaths: ["workers/notes/index.ts"],
    });

    expect(approval).toMatchObject({ units: [], identityKeys: [], unchangedCount: 0 });
  });

  it("admits code-only app changes without restaging unchanged service authority", async () => {
    const { host, appPath, buildSystem } = await makeHarness({
      readWorkspaceFileAtState: async (_state, filePath) =>
        filePath === "meta/vibestudio.yml"
          ? `systemEpoch: ${WORKSPACE_SYSTEM_EPOCH}\napps:\n  - source: apps/shell\n`
          : null,
    });
    const packagePath = path.join(appPath, "package.json");
    const manifest = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    manifest.vibestudio.authority.serviceRequests = [
      { protocol: "example.tasks.v1", availability: "required" },
    ];
    fs.writeFileSync(packagePath, JSON.stringify(manifest));
    host.setDeclared([{ source: "apps/shell", ref: "main" }]);
    const current = await buildSystem.resolveBuildUnitIdentity();
    buildSystem.resolveBuildUnitIdentity.mockResolvedValueOnce({
      ...current,
      effectiveVersion: "ev-next",
    });

    const approval = await host.unitChangeApprovalForCommit("state:next");

    expect(approval.units).toEqual([]);
    expect(approval.unchangedCount).toBe(1);
    expect(approval.identityKeys).toHaveLength(1);
  });

  it("reviews a changed service contract even when the app manifest is unchanged", async () => {
    const { host, buildSystem } = await makeHarness({
      readWorkspaceFileAtState: async (_state, filePath) =>
        filePath === "meta/vibestudio.yml"
          ? `systemEpoch: ${WORKSPACE_SYSTEM_EPOCH}\napps:\n  - source: apps/shell\n`
          : null,
    });
    host.setDeclared([{ source: "apps/shell", ref: "main" }]);
    const current = await buildSystem.resolveBuildUnitIdentity();
    const serviceReviews = [
      {
        capability: "workspace-service:example.tasks.v1",
        providerUnit: "workers/tasks",
        catalogDigest: "changed-contract",
        presentation: {
          action: "manage tasks",
          authorityCategory: { domain: "automation" as const, verb: "manage" as const },
          notability: "everyday" as const,
        },
      },
    ];
    buildSystem.resolveBuildUnitIdentity.mockResolvedValueOnce({
      ...current,
      effectiveVersion: "ev-next",
      serviceReviews,
    } as never);

    const approval = await host.unitChangeApprovalForCommit("state:next");

    expect(approval.unchangedCount).toBe(0);
    expect(approval.units).toMatchObject([{ authority: { serviceReviews } }]);
  });

  it("treats an omitted static app capability list as an empty declaration", async () => {
    const readWorkspaceFileAtState = vi.fn(async (_stateHash: string, filePath: string) =>
      filePath === "meta/vibestudio.yml"
        ? `systemEpoch: ${WORKSPACE_SYSTEM_EPOCH}\napps:\n  - source: apps/shell\n`
        : null
    );
    const { host, appPath } = await makeHarness({ readWorkspaceFileAtState });
    fs.writeFileSync(
      path.join(appPath, "package.json"),
      JSON.stringify({
        name: "@workspace-apps/shell",
        version: "1.0.0",
        vibestudio: {
          displayName: "Shell App",
          app: { target: "electron", renderer: "index.tsx" },
          authority: { requests: [], provides: [] },
        },
      })
    );

    const approval = await host.unitChangeApprovalForCommit("state:next");

    expect(approval.units).toEqual([
      expect.objectContaining({
        unitKind: "app",
        unitName: "@workspace-apps/shell",
        capabilities: [],
      }),
    ]);
  });

  it("builds and registers Electron releases without activating them", async () => {
    const { host, buildSystem, eventService, entityCache } = await makeHarness();

    await host.reconcileDeclared([{ source: "apps/shell", ref: "main" }]);
    await host.whenSettled();

    expect(buildSystem.getStoredBuild).toHaveBeenCalledWith("@workspace-apps/shell", "main");
    expect(host.registry.get("@workspace-apps/shell")).toMatchObject({
      unitKind: "app",
      target: "electron",
      activeBundleKey: "app-key",
      activeSourceHash: "state:test",
      status: "available",
    });
    expect(eventService.emit).not.toHaveBeenCalledWith(
      "supervision:changed",
      expect.objectContaining({ change: "adopted" })
    );
    expect(entityCache.resolveActive("@workspace-apps/shell")).toBeNull();
  });

  it("keeps an existing approved Electron release prepared after restart", async () => {
    const { host, buildSystem, entityCache, graphNode } = await makeHarness();
    installApp(host, graphNode);

    expect(entityCache.resolveActive("@workspace-apps/shell")).toBeNull();

    await host.reconcileDeclared([{ source: "apps/shell", ref: "main" }]);
    await host.whenSettled();

    expect(buildSystem.getStoredBuild).not.toHaveBeenCalled();
    expect(entityCache.resolveActive("@workspace-apps/shell")).toBeNull();
  });

  it("surfaces push rebuild failures and keeps the previous app build active", async () => {
    const { host, buildSystem, eventService, notificationService, diagnostics, graphNode } =
      await makeHarness();
    installApp(host, graphNode);
    buildSystem.getStoredBuild.mockRejectedValueOnce(new Error("broken app code"));

    const onPush = buildSystem.onPushBuild.mock.calls[0]?.[0] as
      | ((source: string) => void)
      | undefined;
    expect(onPush).toBeDefined();
    onPush?.("apps/shell");
    await flushAsyncWork();

    expect(host.registry.get("@workspace-apps/shell")).toMatchObject({
      status: "running",
      lastError: "broken app code",
      lastErrorDetails: expect.objectContaining({ phase: "build", source: "apps/shell" }),
      activeBundleKey: "app-key",
      activeEv: "ev-app",
    });
    expect(eventService.emit).toHaveBeenCalledWith(
      "supervision:changed",
      expect.objectContaining({
        identity: { kind: "app", entityId: "@workspace-apps/shell" },
        change: "status",
        status: "running",
        lastError: "broken app code",
        artifact: expect.objectContaining({ buildKey: "app-key" }),
        canRollback: false,
      })
    );
    expect(diagnostics.history("@workspace-apps/shell").errors[0]).toMatchObject({
      message: "broken app code",
      fields: {
        status: "running",
        errorDetails: { phase: "build", source: "apps/shell" },
      },
    });
    expect(eventService.emit).toHaveBeenCalledWith(
      "supervision:changed",
      expect.objectContaining({
        identity: { kind: "app", entityId: "@workspace-apps/shell" },
        change: "update-rejected",
        status: "running",
        lastError: "broken app code",
      })
    );
    expect(notificationService.show).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        title: "Update not adopted",
      })
    );
  });

  it("rebuilds an installed app when its main-head effective version changes", async () => {
    const { host, buildSystem, eventService, graphNode } = await makeHarness();
    installApp(host, graphNode);
    const changedBuild = {
      buildKey: path.basename(
        path.join(path.dirname(graphNode.path), "..", "..", "state", "builds", "app-key-2")
      ),
      sourceStateHash: "state:test",

      dir: path.join(path.dirname(graphNode.path), "..", "..", "state", "builds", "app-key-2"),
      metadata: {
        ...TEST_SEALED_APP_BUILD_METADATA,
        ev: "ev-app-2",
        sourceStateHash: "state:test",
        details: { kind: "app" as const, target: "electron" as const, integrity: "sha256-app-2" },
        buildKey: path.basename(
          path.join(path.dirname(graphNode.path), "..", "..", "state", "builds", "app-key-2")
        ),
      },
      artifacts: [
        storedArtifact(
          path.join(path.dirname(graphNode.path), "..", "..", "state", "builds", "app-key-2"),
          "index.html",
          "<!doctype html><div>new</div>",
          { role: "html", contentType: "text/html; charset=utf-8", encoding: "utf8" }
        ),
      ],
    };
    buildSystem.getStoredBuild.mockResolvedValueOnce(changedBuild as never);

    const onUnitChange = buildSystem.onUnitChange.mock.calls[0]?.[0] as
      | ((event: {
          name: string;
          relativePath: string;
          kind: string;
          trigger: ProtectedPublicationEvent;
        }) => void)
      | undefined;
    expect(onUnitChange).toBeDefined();

    onUnitChange?.({
      name: "@workspace-apps/shell",
      relativePath: "apps/shell",
      kind: "app",
      trigger: publicationEvent(),
    });
    await flushAsyncWork();

    expect(buildSystem.getStoredBuild).toHaveBeenCalledWith("@workspace-apps/shell", "main");
    expect(host.registry.get("@workspace-apps/shell")).toMatchObject({
      status: "available",
      activeBundleKey: "app-key-2",
      activeEv: "ev-app-2",
      previousVersions: [
        expect.objectContaining({ activeBundleKey: "app-key", activeEv: "ev-app" }),
      ],
    });
    expect(eventService.emit).toHaveBeenCalledWith(
      "supervision:changed",
      expect.objectContaining({
        change: "adopted",
        identity: { kind: "app", entityId: "@workspace-apps/shell" },
        artifact: expect.objectContaining({ buildKey: "app-key-2" }),
        previousBuildKey: "app-key",
        adoption: "prompt",
      })
    );
  });

  it("records app version history and can roll back to the previous build", async () => {
    const { host, buildSystem, eventService, notificationService, graphNode, root } =
      await makeHarness();
    installApp(host, graphNode);
    const oldBuildDir = path.join(root, "state", "builds", "app-key");
    const newBuildDir = path.join(root, "state", "builds", "app-key-2");
    const buildByKey = new Map([
      [
        "app-key",
        {
          buildKey: path.basename(oldBuildDir),
          sourceStateHash: "state:test",

          dir: oldBuildDir,
          metadata: {
            ...TEST_SEALED_APP_BUILD_METADATA,
            ev: "ev-app",
            sourceStateHash: "state:test",
            details: { kind: "app" as const, target: "electron" as const, integrity: "sha256-app" },
            buildKey: path.basename(oldBuildDir),
          },
          artifacts: [
            storedArtifact(oldBuildDir, "index.html", "<!doctype html><div>old</div>", {
              role: "html",
              contentType: "text/html; charset=utf-8",
              encoding: "utf8",
            }),
          ],
        },
      ],
      [
        "app-key-2",
        {
          buildKey: path.basename(newBuildDir),
          sourceStateHash: "state:test",

          dir: newBuildDir,
          metadata: {
            ...TEST_SEALED_APP_BUILD_METADATA,
            ev: "ev-app-2",
            sourceStateHash: "state:test",
            details: {
              kind: "app" as const,
              target: "electron" as const,
              integrity: "sha256-app-2",
            },
            buildKey: path.basename(newBuildDir),
          },
          artifacts: [
            storedArtifact(newBuildDir, "index.html", "<!doctype html><div>new</div>", {
              role: "html",
              contentType: "text/html; charset=utf-8",
              encoding: "utf8",
            }),
          ],
        },
      ],
    ]);
    buildSystem.getBuildByKey.mockImplementation(
      async (key: string) => (buildByKey.get(key) ?? null) as never
    );
    buildSystem.getStoredBuild.mockResolvedValueOnce(buildByKey.get("app-key-2")! as never);

    const onPush = buildSystem.onPushBuild.mock.calls[0]?.[0] as
      | ((source: string) => void)
      | undefined;
    expect(onPush).toBeDefined();
    onPush?.("apps/shell");
    await flushAsyncWork();

    expect(host.registry.get("@workspace-apps/shell")).toMatchObject({
      status: "available",
      activeBundleKey: "app-key-2",
      activeEv: "ev-app-2",
      previousVersions: [
        expect.objectContaining({ activeBundleKey: "app-key", activeEv: "ev-app" }),
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
            id: "runtime.supervision.rollback",
            command: {
              type: "runtime.supervision.rollback",
              release: { kind: "app", releaseId: "@workspace-apps/shell" },
            },
          }),
        ]),
      })
    );
    await expect(host.servesBuild("app-key")).resolves.toBe(true);

    await host.rollbackAppVersion("@workspace-apps/shell");

    expect(host.registry.get("@workspace-apps/shell")).toMatchObject({
      status: "running",
      activeBundleKey: "app-key",
      activeEv: "ev-app",
      previousVersions: [
        expect.objectContaining({ activeBundleKey: "app-key-2", activeEv: "ev-app-2" }),
      ],
    });
    expect(eventService.emit).toHaveBeenCalledWith(
      "supervision:changed",
      expect.objectContaining({
        change: "rolled-back",
        identity: { kind: "app", entityId: "@workspace-apps/shell" },
        artifact: expect.objectContaining({ buildKey: "app-key" }),
        canRollback: true,
      })
    );
  });

  it("activates an exact prepared Electron release", async () => {
    const { host, buildSystem, eventService, graphNode } = await makeHarness();
    graphNode.manifest.app.capabilities = ["panel-hosting"] as never;
    installApp(host, graphNode);
    buildSystem.getBuildByKey.mockResolvedValue({
      sourceStateHash: "state:test",

      dir: path.join(graphNode.path, "..", "..", "..", "state", "builds", "app-key"),
      buildKey: "app-key",
      metadata: {
        ...TEST_SEALED_APP_BUILD_METADATA,
        ev: "ev-app",
        sourceStateHash: "state:test",
        execution: TEST_EXECUTION_IDENTITY,
        authority: {
          provides: [],
          requests: [
            {
              capability: "service:events.watch",
              resource: { kind: "exact", key: "service:events.watch" },
              tier: "gated",
              evidence: "exact",
            },
          ],
        },
        details: { kind: "app", target: "electron", integrity: "sha256-app" },
        buildKey: "app-key",
      },
      artifacts: [
        storedArtifact(
          path.join(graphNode.path, "..", "..", "..", "state", "builds", "app-key"),
          "index.html",
          "<!doctype html><div>app</div>",
          {
            role: "html",
            contentType: "text/html; charset=utf-8",
            encoding: "utf8",
          }
        ),
      ],
    });

    await expect(host.activateRelease("@workspace-apps/shell")).resolves.toBeUndefined();
    expect(eventService.emit).toHaveBeenCalledWith(
      "supervision:changed",
      expect.objectContaining({
        identity: { kind: "app", entityId: "@workspace-apps/shell" },
        source: "apps/shell",
        change: "adopted",
        app: expect.objectContaining({ target: "electron" }),
      })
    );
  });

  it("prepares an unbuilt Electron release before activation", async () => {
    const { host, buildSystem, eventService, graphNode } = await makeHarness();
    graphNode.manifest.app.capabilities = ["panel-hosting"] as never;

    host.setDeclared([{ source: "apps/shell", ref: "main" }]);

    await host.reconcileDeclared([{ source: "apps/shell", ref: "main" }]);
    await host.whenSettled();
    await expect(host.activateRelease("@workspace-apps/shell")).resolves.toBeUndefined();
    expect(buildSystem.getStoredBuild).toHaveBeenCalledWith("@workspace-apps/shell", "main");
    expect(host.registry.get("@workspace-apps/shell")).toMatchObject({
      target: "electron",
      activeBundleKey: "app-key",
      status: "running",
    });
    expect(eventService.emit).toHaveBeenCalledWith(
      "supervision:changed",
      expect.objectContaining({
        identity: { kind: "app", entityId: "@workspace-apps/shell" },
        source: "apps/shell",
        change: "adopted",
        app: expect.objectContaining({ target: "electron" }),
      })
    );
  });

  it("records app declarations passively and prepares only the selected host target", async () => {
    const { host, buildSystem, approvalQueue, graphNode, workspacePath } = await makeHarness();
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
    expect(buildSystem.getStoredBuild).not.toHaveBeenCalled();

    await expect(host.ensureElectronReady()).resolves.toMatchObject({
      ready: true,
      source: "apps/shell",
      appId: "@workspace-apps/shell",
      buildKey: "app-key",
      artifactRoute: "/_a/app-key/index.html",
    });

    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "unit-install-review",
        mode: "adopt-root",
        title: "Start this workspace?",
        units: [
          expect.objectContaining({
            unitKind: "app",
            unitName: "@workspace-apps/shell",
            icon: "🖥️",
            source: { kind: "workspace-repo", repo: "apps/shell", ref: "main" },
          }),
        ],
      })
    );
    expect(buildSystem.getStoredBuild.mock.calls).toEqual([["@workspace-apps/shell", "main"]]);
    expect(host.registry.get("@workspace-apps/mobile")).toBeNull();
  });

  it("activates the Electron shell after startup approval", async () => {
    const { host, buildSystem, eventService, graphNode, approvalQueue } = await makeHarness();
    graphNode.manifest.app.capabilities = ["panel-hosting"] as never;

    await host.reconcileDeclared([{ source: "apps/shell", ref: "main" }]);
    await host.whenSettled();

    await expect(host.activateRelease("@workspace-apps/shell")).resolves.toBeUndefined();
    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "unit-install-review",
        mode: "adopt-root",
        units: [
          expect.objectContaining({
            unitKind: "app",
            unitName: "@workspace-apps/shell",
            target: "electron",
          }),
        ],
      })
    );
    expect(buildSystem.getStoredBuild).toHaveBeenCalledWith("@workspace-apps/shell", "main");
    expect(eventService.emit).toHaveBeenCalledWith(
      "supervision:changed",
      expect.objectContaining({
        identity: { kind: "app", entityId: "@workspace-apps/shell" },
        source: "apps/shell",
        change: "adopted",
        app: expect.objectContaining({ target: "electron" }),
      })
    );
  });

  it("publishes pending startup approvals through the shared coordinator", async () => {
    const { host, graphNode, approvalQueue, approvalCoordinator } = await makeHarness({
      useApprovalCoordinator: true,
    });
    graphNode.manifest.app.capabilities = ["panel-hosting"] as never;

    await host.reconcileDeclared([{ source: "apps/shell", ref: "main" }]);

    expect(host.registry.get(graphNode.name)).toMatchObject({ status: "pending-approval" });
    expect(approvalQueue.request).not.toHaveBeenCalled();

    approvalCoordinator?.publishPending("startup");

    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "unit-install-review",
        mode: "adopt-root",
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

  it("reports an approved, prepared Electron shell as serveable before generic activation", async () => {
    const { host, buildSystem, graphNode } = await makeHarness();
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
    expect(buildSystem.getStoredBuild).toHaveBeenCalledWith("@workspace-apps/shell", "main");
    expect(host.registry.get("@workspace-apps/shell")?.status).toBe("available");
  });

  it("rebuilds a current app when its active immutable artifact is missing", async () => {
    const { host, buildSystem, graphNode } = await makeHarness();
    graphNode.manifest.app.capabilities = ["panel-hosting"] as never;
    const declared = [{ source: "apps/shell", ref: "main" }];

    await host.reconcileDeclared(declared);
    await host.whenSettled();
    const built = await buildSystem.getStoredBuild.mock.results[0]!.value;
    buildSystem.getStoredBuild.mockClear();

    let artifactAvailable = false;
    buildSystem.getBuildByKey.mockImplementation(async (key: string) =>
      artifactAvailable && key === "app-key" ? built : null
    );
    buildSystem.getStoredBuild.mockImplementation(async () => {
      artifactAvailable = true;
      return built;
    });

    await host.activateRelease("@workspace-apps/shell");

    expect(buildSystem.getStoredBuild).toHaveBeenCalledExactlyOnceWith(
      "@workspace-apps/shell",
      "main"
    );
    expect(host.registry.get("@workspace-apps/shell")).toMatchObject({
      activeBundleKey: "app-key",
      status: "running",
      lastError: null,
    });
    await expect(host.ensureElectronReady()).resolves.toMatchObject({
      ready: true,
      buildKey: "app-key",
    });
  });

  it("prebuilds the selected Electron artifact without admitting or activating it", async () => {
    const { host, buildSystem, eventService, graphNode } = await makeHarness();
    graphNode.manifest.app.capabilities = ["panel-hosting"] as never;

    host.setDeclared([{ source: "apps/shell", ref: "main" }]);
    const readiness = await host.prepareElectronArtifact();

    expect(readiness).toMatchObject({
      ready: true,
      source: "apps/shell",
      appId: "@workspace-apps/shell",
      buildKey: "app-key",
      artifactRoute: "/_a/app-key/index.html",
    });
    expect(buildSystem.getStoredBuild).toHaveBeenCalledWith("@workspace-apps/shell", "main");
    expect(host.registry.get("@workspace-apps/shell")).toBeNull();
    expect(eventService.emit).not.toHaveBeenCalledWith(
      "supervision:changed",
      expect.objectContaining({ change: "adopted" })
    );
  });

  it("advertises Electron shell artifacts as gateway routes", async () => {
    const { host, eventService, graphNode } = await makeHarness({
      reactNativeAppArtifactBaseUrl: "https://host.tailnet.ts.net",
    });
    graphNode.manifest.app.capabilities = ["panel-hosting"] as never;

    host.setDeclared([{ source: "apps/shell", ref: "main" }]);
    await host.ensureElectronReady();
    await host.activateRelease("@workspace-apps/shell");
    const readiness = await host.ensureElectronReady();

    expect(readiness).toMatchObject({
      ready: true,
      source: "apps/shell",
      appId: "@workspace-apps/shell",
      buildKey: "app-key",
      artifactRoute: "/_a/app-key/index.html",
    });
    expect(eventService.emit).toHaveBeenCalledWith(
      "supervision:changed",
      expect.objectContaining({
        identity: { kind: "app", entityId: "@workspace-apps/shell" },
        source: "apps/shell",
        change: "adopted",
        adoption: "immediate",
        app: expect.objectContaining({
          target: "electron",
          artifactRoute: "/_a/app-key/index.html",
        }),
      })
    );
  });

  it("keeps panel-hosting in the adoption for a trusted chrome app", async () => {
    const { host, eventService, graphNode } = await makeHarness();
    // This workspace manifest grants chrome authority to apps/shell.
    graphNode.manifest.app.capabilities = ["panel-hosting", "notifications"] as never;

    await host.reconcileDeclared([{ source: "apps/shell", ref: "main" }]);
    await host.whenSettled();
    await host.activateRelease("@workspace-apps/shell");

    expect(eventService.emit).toHaveBeenCalledWith(
      "supervision:changed",
      expect.objectContaining({
        identity: { kind: "app", entityId: "@workspace-apps/shell" },
        source: "apps/shell",
        change: "adopted",
        app: expect.objectContaining({
          capabilities: expect.arrayContaining(["panel-hosting", "notifications"]),
        }),
      })
    );
  });

  it("uses the owning workspace's current manifest for chrome grants through bootstrap and revocation", async () => {
    let systemTrust = { chromeApps: [] as string[] };
    const system = await makeHarness({ getWorkspaceTrustGrants: () => systemTrust });
    const other = await makeHarness({ getWorkspaceTrustGrants: () => ({ chromeApps: [] }) });
    for (const owner of [system, other]) {
      owner.graphNode.manifest.app.capabilities = ["panel-hosting", "notifications"] as never;
    }
    // Bootstrap materializes the semantic System manifest after its initial descriptor.
    systemTrust = { chromeApps: ["apps/shell"] };
    for (const owner of [system, other]) {
      await owner.host.reconcileDeclared([{ source: "apps/shell", ref: "main" }]);
      await owner.host.whenSettled();
      await owner.host.activateRelease("@workspace-apps/shell");
    }
    expect(system.host.hasAppCapability("@workspace-apps/shell", "panel-hosting")).toBe(true);
    expect(other.host.hasAppCapability("@workspace-apps/shell", "panel-hosting")).toBe(false);
    expect(system.eventService.emit).toHaveBeenCalledWith(
      "supervision:changed",
      expect.objectContaining({
        change: "adopted",
        app: expect.objectContaining({
          capabilities: expect.arrayContaining(["panel-hosting", "notifications"]),
        }),
      })
    );
    systemTrust = { chromeApps: [] };
    expect(system.host.hasAppCapability("@workspace-apps/shell", "panel-hosting")).toBe(false);
  });

  it("strips panel-hosting from the adoption for an app absent from trust.chromeApps", async () => {
    const { host, eventService, graphNode } = await makeHarness({
      getWorkspaceTrustGrants: () => ({ chromeApps: [] }),
    });
    graphNode.manifest.app.capabilities = ["panel-hosting", "notifications"] as never;

    await host.reconcileDeclared([{ source: "apps/shell", ref: "main" }]);
    await host.whenSettled();
    await host.activateRelease("@workspace-apps/shell");

    expect(eventService.emit).toHaveBeenCalledWith(
      "supervision:changed",
      expect.objectContaining({
        identity: { kind: "app", entityId: "@workspace-apps/shell" },
        change: "adopted",
        app: expect.objectContaining({ capabilities: ["notifications"] }),
      })
    );
    // And the server-side authorization check agrees: the capability is not granted.
    expect(host.hasAppCapability("@workspace-apps/shell", "panel-hosting")).toBe(false);
  });

  it("uses the explicitly requested React Native source", async () => {
    const { host, buildSystem, graphNode, workspacePath } = await makeHarness();
    const otherNode = createAppGraphNode(workspacePath, "apps/field-mobile", {
      name: "@workspace-apps/field-mobile",
      target: "react-native",
      capabilities: ["notifications"],
    });
    buildSystem.getGraph.mockReturnValue({
      allNodes: () => [graphNode, otherNode],
    } as never);
    const rnBuild = (key: string, ev: string) => ({
      buildKey: path.basename(path.join(workspacePath, "..", "state", "builds", key)),
      sourceStateHash: "state:test",

      dir: path.join(workspacePath, "..", "state", "builds", key),
      metadata: {
        ...TEST_SEALED_APP_BUILD_METADATA,
        ev,
        details: {
          kind: "app" as const,
          target: "react-native" as const,
          integrity: `sha256-${ev}`,
          rnHostAbi: "rn-host-2",
          provider: REACT_NATIVE_PROVIDER,
        },
        buildKey: path.basename(path.join(workspacePath, "..", "state", "builds", key)),
      },
      artifacts: [
        storedArtifact(
          path.join(workspacePath, "..", "state", "builds", key),
          "index.ios.bundle",
          "bundle",
          {
            role: "primary",
            contentType: "application/javascript; charset=utf-8",
            encoding: "utf8",
            platform: "ios",
          }
        ),
      ],
    });
    buildSystem.getBuildByKey.mockImplementation(async (key: string) => {
      if (key === "mobile-key") return rnBuild(key, "ev-mobile") as never;
      if (key === "field-key") return rnBuild(key, "ev-field") as never;
      return null;
    });
    installAppEntry(host, graphNode, {
      target: "react-native",
      activeBundleKey: "mobile-key",
      activeExecutionDigest: TEST_EXECUTION_IDENTITY.executionDigest,
      activeEv: "ev-mobile",
      capabilities: ["notifications"],
    });
    host.registry.patch(graphNode.name, {
      source: { kind: "workspace-repo", repo: "apps/mobile", ref: "main" },
    });
    installAppEntry(host, otherNode, {
      target: "react-native",
      activeBundleKey: "field-key",
      activeExecutionDigest: TEST_EXECUTION_IDENTITY.executionDigest,
      activeEv: "ev-field",
      capabilities: ["notifications", "panel-hosting"],
    });

    expect(await host.reactNative.getBootstrap("apps/field-mobile")).toMatchObject({
      appId: "@workspace-apps/field-mobile",
      buildKey: "field-key",
      effectiveVersion: "ev-field",
    });
    expect(
      (await host.registerDevicePrincipal("react-native", "device-1", "apps/field-mobile"))
        ?.principalId
    ).toBe("app:apps/field-mobile:device-1");
    expect(host.hasAppCapability("app:apps/field-mobile:device-1", "panel-hosting")).toBe(false);
    expect(host.hasAppCapability("app:apps/mobile:device-1", "panel-hosting")).toBe(false);
  });

  ledgerTest("execution.electron-app", async () => {
    const { host, buildSystem, graphNode, root } = await makeHarness();
    graphNode.manifest.app.capabilities = ["panel-hosting", "notifications"] as never;
    const pinnedBuild = {
      buildKey: path.basename(path.join(root, "state", "builds", "pinned-ref-key")),
      sourceStateHash: "state:test",

      dir: path.join(root, "state", "builds", "pinned-ref-key"),
      metadata: {
        ...TEST_SEALED_APP_BUILD_METADATA,
        ev: "ev-pinned",
        sourceStateHash: "state:test",
        details: { kind: "app" as const, target: "electron" as const, integrity: "sha256-pinned" },
        buildKey: path.basename(path.join(root, "state", "builds", "pinned-ref-key")),
      },
      artifacts: [
        storedArtifact(
          path.join(root, "state", "builds", "pinned-ref-key"),
          "index.html",
          "<!doctype html><div>pinned</div>",
          { role: "html", contentType: "text/html; charset=utf-8", encoding: "utf8" }
        ),
      ],
    };
    buildSystem.getStoredBuild.mockResolvedValueOnce(pinnedBuild as never);

    const result = await host.prepareRelease("apps/shell", "state:0123456789abcdef");

    expect(result).toMatchObject({
      buildKey: "pinned-ref-key",
      effectiveVersion: "ev-pinned",
      appId: "@workspace-apps/shell",
      source: "apps/shell",
    });
    const entry = host.registry.get("@workspace-apps/shell");
    expect(entry).toMatchObject({
      activeBundleKey: "pinned-ref-key",
      activeEv: "ev-pinned",
      source: { ref: "state:0123456789abcdef" },
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
      source: { repo: "apps/shell", ref: "state:0123456789abcdef" },
      effectiveVersion: "ev-pinned",
      capabilities: ["notifications", "panel-hosting"],
    });
  });

  it("emits a development app status diagnostic", async () => {
    process.env["VIBESTUDIO_APP_DEV_STATUS"] = "1";
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => {});
    const { host } = await makeHarness();

    try {
      await host.reconcileDeclared([{ source: "apps/shell", ref: "main" }]);
      await host.whenSettled();

      expect(consoleInfo).toHaveBeenCalledWith(expect.stringContaining("@workspace-apps/shell"));
      expect(consoleInfo).toHaveBeenCalledWith(expect.stringContaining("ev=ev-app"));
      expect(consoleInfo).toHaveBeenCalledWith(expect.stringContaining("build=app-key"));
      expect(consoleInfo).toHaveBeenCalledWith(expect.stringContaining("ref=main"));
    } finally {
      consoleInfo.mockRestore();
    }
  });

  it("bakes only the active approved app build for dist packaging", async () => {
    const { host, graphNode, buildSystem } = await makeHarness();
    installApp(host, graphNode);
    const outDir = path.join(tempRoot(), "dist", "baked-app");
    const activeBuild = await buildSystem.getBuildByKey("app-key");
    const buildKey = "b".repeat(64);
    const effectiveVersion = "e".repeat(64);
    const sourceStateHash = `state:${"c".repeat(64)}`;
    host.registry.patch(graphNode.name, {
      activeBundleKey: buildKey,
      activeExecutionDigest: TEST_EXECUTION_IDENTITY.executionDigest,
      activeEv: effectiveVersion,
      activeSourceHash: sourceStateHash,
    });
    const artifacts = activeBuild?.artifacts ?? [];
    const artifactDigest = domainHash(
      "vibestudio/build-v2-artifacts/v1",
      canonicalJson(
        artifacts.map((artifact) => ({
          path: artifact.path,
          role: artifact.role,
          contentType: artifact.contentType,
          encoding: artifact.encoding,
          platform: (artifact as { platform?: string }).platform ?? null,
          integrity: artifact.integrity ?? null,
        }))
      )
    );
    const contentRoots = [{ repoPath: "apps/shell", stateHash: sourceStateHash }];
    const unsignedExecution = {
      version: 1 as const,
      sourceState: {
        kind: "workspace" as const,
        workspaceId: "workspace:test",
        effectiveVersion: effectiveVersion as never,
        state: { kind: "event" as const, eventId: "event:test" },
        contentRoots,
        sourceClosureDigest: executionSourceClosureDigest(contentRoots),
      },
      recipeDigest: buildKey as never,
      buildKey: buildKey as never,
      artifactDigest,
    };
    const execution = {
      ...unsignedExecution,
      executionDigest: executionArtifactDigest(unsignedExecution),
    };
    buildSystem.getBuildByKey.mockResolvedValueOnce({
      ...activeBuild,
      buildKey,
      sourceStateHash,
      artifacts,
      metadata: {
        ...TEST_SEALED_APP_BUILD_METADATA,
        ...activeBuild?.metadata,
        buildKey,
        sourcePath: "apps/shell",
        sourceStateHash,
        sourceState: { kind: "event", eventId: "event:test" },
        ev: effectiveVersion,
        authority: { requests: [], provides: [] },
        execution,
      },
    } as never);

    const manifest = await host.bakeDist("apps/shell", outDir);

    expect(manifest).toMatchObject({
      app: {
        name: "@workspace-apps/shell",
        source: "apps/shell",
        target: "electron",
      },
      build: {
        key: buildKey,
        effectiveVersion,
        target: "electron",
        integrity: "sha256-app",
        executionDigest: execution.executionDigest,
        authority: { requests: [], provides: [] },
      },
    });
    expect(fs.existsSync(path.join(outDir, "manifest.json"))).toBe(true);
    expect(fs.readFileSync(path.join(outDir, "artifacts", "index.html"), "utf8")).toBe(
      "<!doctype html><div>app</div>"
    );
  });

  it("registers device-scoped React Native app principals for native-held grants", async () => {
    const { host, buildSystem, graphNode, entityCache } = await makeHarness();
    installApp(host, graphNode);
    host.registry.patch(graphNode.name, {
      target: "react-native",
      source: { kind: "workspace-repo", repo: "apps/mobile", ref: "main" },
      activeEv: "ev-mobile",
      activeBundleKey: "mobile-key",
      activeExecutionDigest: TEST_EXECUTION_IDENTITY.executionDigest,
      capabilities: ["notifications"],
    });
    buildSystem.getBuildByKey.mockResolvedValue({
      dir: "/builds/mobile-key",
      buildKey: "mobile-key",
      metadata: {
        ...TEST_SEALED_APP_BUILD_METADATA,
        buildKey: "mobile-key",
        sourcePath: "apps/mobile",
        ev: "ev-mobile",
        details: {
          kind: "app",
          target: "react-native",
          integrity: "sha256-mobile",
          rnHostAbi: "v1",
        },
      },
    } as never);

    const callerId = (await host.registerDevicePrincipal("react-native", "device-1"))?.principalId;

    expect(callerId).toBe("app:apps/mobile:device-1");
    expect(entityCache.resolveActive("app:apps/mobile:device-1")).toMatchObject({
      id: "app:apps/mobile:device-1",
      kind: "app",
      source: { repoPath: "apps/mobile", effectiveVersion: "ev-mobile" },
      activeBuildKey: "mobile-key",
      activeExecutionDigest: "a".repeat(64),
      activeAuthority: { requests: [], provides: [] },
      status: "active",
    });
    const connectionGrants = new ConnectionGrantService({ entityCache });
    expect(() => connectionGrants.grant(callerId!, "native-mobile:device-1")).not.toThrow();
    connectionGrants.stop();

    expect(host.principals.retireDevice("device-1")).toBe(1);
    expect(entityCache.resolveActive("app:apps/mobile:device-1")).toBeNull();
  });

  it("registers mobile app grants for the same canonical source used by bootstrap", async () => {
    const { host, buildSystem, graphNode, entityCache } = await makeHarness();
    installApp(host, graphNode);
    const base = host.registry.get(graphNode.name);
    if (!base) throw new Error("expected test app registry entry");
    host.registry.patch(graphNode.name, {
      target: "react-native",
      source: { kind: "workspace-repo", repo: "apps/other-mobile", ref: "main" },
      activeEv: "ev-other-mobile",
      activeBundleKey: "other-mobile-key",
      activeExecutionDigest: TEST_EXECUTION_IDENTITY.executionDigest,
      capabilities: ["notifications"],
    });
    buildSystem.getBuildByKey.mockImplementation(async (key: string) =>
      key === "mobile-key"
        ? ({
            dir: "/builds/mobile-key",
            buildKey: "mobile-key",
            metadata: {
              ...TEST_SEALED_APP_BUILD_METADATA,
              buildKey: "mobile-key",
              sourcePath: "apps/mobile",
              ev: "ev-mobile",
              details: {
                kind: "app",
                target: "react-native",
                integrity: "sha256-mobile",
                rnHostAbi: "v1",
              },
            },
          } as never)
        : null
    );
    host.registry.upsert({
      ...base,
      name: "@workspace-apps/mobile",
      target: "react-native",
      source: { kind: "workspace-repo", repo: "apps/mobile", ref: "main" },
      activeEv: "ev-mobile",
      activeBundleKey: "mobile-key",
      activeExecutionDigest: TEST_EXECUTION_IDENTITY.executionDigest,
      capabilities: ["notifications"],
    });

    const callerId = (await host.registerDevicePrincipal("react-native", "device-1"))?.principalId;

    expect(callerId).toBe("app:apps/mobile:device-1");
    expect(entityCache.resolveActive("app:apps/mobile:device-1")).toMatchObject({
      source: { repoPath: "apps/mobile", effectiveVersion: "ev-mobile" },
    });
    expect(entityCache.resolveActive("app:apps/other-mobile:device-1")).toBeNull();
  });

  it("refuses to register an executable mobile principal without its exact sealed build", async () => {
    const { host, graphNode, entityCache } = await makeHarness();
    installApp(host, graphNode);
    host.registry.patch(graphNode.name, {
      target: "react-native",
      source: { kind: "workspace-repo", repo: "apps/mobile", ref: "main" },
      activeEv: "ev-mobile",
      activeBundleKey: "missing-build",
      activeExecutionDigest: TEST_EXECUTION_IDENTITY.executionDigest,
    });

    await expect(host.registerDevicePrincipal("react-native", "device-1")).rejects.toThrow(
      "immutable build missing-build is unavailable"
    );
    expect(entityCache.resolve("app:apps/mobile:device-1")).toBeNull();
  });

  it("authorizes app capabilities by installed app and device-scoped principals", async () => {
    const { host, graphNode } = await makeHarness();
    installApp(host, graphNode);
    host.registry.patch(graphNode.name, {
      capabilities: ["notifications", "panel-hosting"],
      source: { kind: "workspace-repo", repo: "apps/shell", ref: "main" },
    });
    const authorizer = host.capabilityAuthorizer();

    expect(
      authorizer.check(createVerifiedCaller("@workspace-apps/shell", "app"), "notifications")
    ).toEqual({ allowed: true });
    expect(
      authorizer.check(createVerifiedCaller("app:apps/shell:device-1", "app"), "notifications")
    ).toEqual({ allowed: true });
    expect(
      authorizer.check(createVerifiedCaller("@workspace-apps/shell", "app"), "panel-hosting")
    ).toEqual({ allowed: true });

    host.registry.patch(graphNode.name, {
      source: { kind: "workspace-repo", repo: "apps/field-mobile", ref: "main" },
    });
    expect(
      authorizer.check(
        createVerifiedCaller("app:apps/field-mobile:device-1", "app"),
        "panel-hosting"
      )
    ).toMatchObject({ allowed: false });
  });

  ledgerTest("execution.terminal-app", async () => {
    // A terminal app is built, admitted and activated like any other app: no
    // server process exists. The `vibestudio terminal` client imports the
    // exact module through a device-scoped principal bound to the active build.
    const { host, buildSystem, eventService, approvalQueue, entityCache, workspacePath, root } =
      await makeHarness({
        isAdmitted: () => true,
        readWorkspaceFileAtState: async (_stateHash, filePath) =>
          filePath === "apps/terminal-browser/package.json"
            ? fs.readFileSync(path.join(workspacePath, filePath), "utf8")
            : null,
      });
    const graphNode = createAppGraphNode(workspacePath, "apps/terminal-browser", {
      name: "@workspace-apps/terminal-browser",
      target: "terminal",
      capabilities: ["clipboard"],
    });
    buildSystem.getGraph.mockReturnValue({ allNodes: () => [graphNode] } as never);
    buildSystem.getEffectiveVersion.mockImplementation((name: string) =>
      name === graphNode.name ? "ev-terminal" : null
    );
    buildSystem.listAffectedBuildUnits.mockResolvedValue([graphNode.name]);
    const unitIdentity = await buildSystem.resolveBuildUnitIdentity();
    buildSystem.resolveBuildUnitIdentity.mockResolvedValue({
      ...unitIdentity,
      unitPath: graphNode.relativePath,
      unitName: graphNode.name,
      effectiveVersion: "ev-terminal",
    });
    const buildDir = path.join(root, "state", "builds");
    const terminalBuild = {
      buildKey: "terminal-key",
      sourceStateHash: "state:test",
      dir: path.join(buildDir, "terminal-key"),
      metadata: {
        ...TEST_SEALED_APP_BUILD_METADATA,
        ev: "ev-terminal",
        sourceStateHash: "state:test",
        execution: TEST_EXECUTION_IDENTITY,
        authority: { requests: [], provides: [] },
        details: {
          kind: "app",
          target: "terminal",
          integrity: null,
          rnHostAbi: null,
          provider: null,
        },
        buildKey: "terminal-key",
      },
      artifacts: [
        storedArtifact(path.join(buildDir, "terminal-key"), "index.mjs", "export {};\n", {
          role: "primary",
          contentType: "text/javascript; charset=utf-8",
          encoding: "utf8",
        }),
      ],
    };
    buildSystem.getStoredBuild.mockResolvedValueOnce(terminalBuild as never);
    buildSystem.getBuildByKey.mockImplementation(async (key: string) =>
      key === "terminal-key" ? (terminalBuild as never) : null
    );

    await host.reconcileDeclared([{ source: graphNode.relativePath, ref: "main" }]);
    await host.whenSettled();

    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "unit-install-review",
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
    });
    // Before activation the app has no running build, so no device can take
    // its principal.
    host.registry.patch(graphNode.name, { status: "available" });
    expect(await host.registerDevicePrincipal("terminal", "device-1")).toBeNull();
    expect(entityCache.resolve("app:apps/terminal-browser:device-1")).toBeNull();

    await host.activateRelease(graphNode.name);

    expect(host.registry.get(graphNode.name)).toMatchObject({
      status: "running",
      lastError: null,
    });
    expect(entityCache.resolveActive(graphNode.name)).toMatchObject({
      kind: "app",
      activeBuildKey: "terminal-key",
      activeExecutionDigest: TEST_EXECUTION_IDENTITY.executionDigest,
      status: "active",
    });
    expect(eventService.emit).toHaveBeenCalledWith(
      "supervision:changed",
      expect.objectContaining({
        identity: { kind: "app", entityId: graphNode.name },
        source: "apps/terminal-browser",
        change: "adopted",
        adoption: "artifact-only",
        artifact: expect.objectContaining({ buildKey: "terminal-key" }),
        app: expect.objectContaining({
          target: "terminal",
          artifactRoute: "/_a/terminal-key/index.mjs",
        }),
      })
    );

    const principal = await host.registerDevicePrincipal("terminal", "device-1");
    expect(principal).toEqual({
      principalId: "app:apps/terminal-browser:device-1",
      appId: graphNode.name,
      source: "apps/terminal-browser",
      target: "terminal",
      buildKey: "terminal-key",
      effectiveVersion: "ev-terminal",
      artifacts: [
        {
          path: "index.mjs",
          role: "primary",
          contentType: "text/javascript; charset=utf-8",
          route: "/_a/terminal-key/index.mjs",
        },
      ],
    });
    expect(entityCache.resolveActive("app:apps/terminal-browser:device-1")).toMatchObject({
      kind: "app",
      source: { repoPath: "apps/terminal-browser", effectiveVersion: "ev-terminal" },
      activeBuildKey: "terminal-key",
      activeExecutionDigest: TEST_EXECUTION_IDENTITY.executionDigest,
      status: "active",
    });
    expect(host.hasAppCapability("app:apps/terminal-browser:device-1", "clipboard")).toBe(true);
    const connectionGrants = new ConnectionGrantService({ entityCache });
    try {
      expect(() => connectionGrants.grant(principal!.principalId, "shell:device-1")).not.toThrow();
    } finally {
      connectionGrants.stop();
    }

    expect(host.principals.retireDevice("device-1")).toBe(1);
    expect(entityCache.resolveActive("app:apps/terminal-browser:device-1")).toBeNull();
  });

  it("keeps an unaccepted terminal build inspectable but prevents promotion and launch", async () => {
    const review = { approvalId: "review-terminal", title: "Review Terminal Browser" };
    let openReview = true;
    const { host, buildSystem, eventService, graphNode, entityCache } = await makeHarness({
      isAdmitted: () => false,
      openUnitReviewFor: () => (openReview ? review : null),
    });
    setAppManifestTarget(graphNode, "terminal", ["clipboard"]);
    const terminalBuild = {
      buildKey: path.basename(
        path.join(path.dirname(graphNode.path), "..", "..", "state", "builds", "terminal-key")
      ),
      sourceStateHash: "state:test",

      dir: path.join(path.dirname(graphNode.path), "..", "..", "state", "builds", "terminal-key"),
      metadata: {
        ...TEST_SEALED_APP_BUILD_METADATA,
        ev: "ev-terminal-unaccepted",
        sourceStateHash: "state:terminal-unaccepted",
        details: {
          kind: "app",
          target: "terminal",
          integrity: null,
          rnHostAbi: null,
          provider: null,
        },
        buildKey: path.basename(
          path.join(path.dirname(graphNode.path), "..", "..", "state", "builds", "terminal-key")
        ),
      },
      artifacts: [
        storedArtifact(
          path.join(path.dirname(graphNode.path), "..", "..", "state", "builds", "terminal-key"),
          "index.mjs",
          "export {};\n",
          { role: "primary", contentType: "text/javascript; charset=utf-8", encoding: "utf8" }
        ),
      ],
    };
    buildSystem.getStoredBuild.mockResolvedValue(terminalBuild as never);
    buildSystem.getBuildByKey.mockImplementation(async (key: string) =>
      key === "terminal-key" ? (terminalBuild as never) : null
    );

    await expect(
      host.prepareRelease(graphNode.relativePath, "candidate-ref")
    ).resolves.toMatchObject({
      buildKey: "terminal-key",
      effectiveVersion: "ev-terminal-unaccepted",
      source: graphNode.relativePath,
    });
    expect(host.registry.get(graphNode.name)?.activeBundleKey).toBeUndefined();

    host.registry.upsert({
      unitKind: "app",
      name: graphNode.name,
      version: "1.0.0",
      target: "terminal",
      capabilities: ["clipboard"],
      source: { kind: "workspace-repo", repo: graphNode.relativePath, ref: "candidate-ref" },
      installedAt: Date.now(),
      activeEv: "ev-terminal-unaccepted",
      activeSourceHash: "state:terminal-unaccepted",
      activeBundleKey: "terminal-key",
      activeExecutionDigest: TEST_EXECUTION_IDENTITY.executionDigest,
      activeDependencyEvs: {},
      activeExternalDeps: {},
      activeRuntimeDepsKey: null,
      status: "available",
      lastError: null,
      previousVersions: [],
    });
    await expect(host.activateRelease(graphNode.name)).rejects.toMatchObject({
      name: "ServiceAccessError",
      service: "runtime.supervision",
      code: "EREVIEWPENDING",
      errorData: {
        authorityFailure: {
          remediation: {
            kind: "resolve-open-review",
            review,
          },
        },
      },
    });
    expect(entityCache.resolveActive(graphNode.name)).toBeNull();
    expect(host.registry.get(graphNode.name)).toMatchObject({
      activeBundleKey: "terminal-key",
      status: "available",
    });
    expect(eventService.emit).not.toHaveBeenCalledWith(
      "supervision:changed",
      expect.objectContaining({ change: "adopted" })
    );
    expect(
      await host.registerDevicePrincipal("terminal", "device-1", graphNode.relativePath)
    ).toBeNull();

    openReview = false;
    await expect(host.activateRelease(graphNode.name)).rejects.toMatchObject({
      name: "ServiceAccessError",
      service: "runtime.supervision",
      code: "EACCES",
      errorData: {
        authorityFailure: {
          reasonCode: "approval-required",
          remediation: { kind: "request-user-approval" },
        },
      },
    });
    expect(entityCache.listActive()).toEqual([]);
  });

  it("keeps the prior admitted terminal build active when a candidate lacks exact admission", async () => {
    const admitted = new Set(["ev-terminal-old"]);
    const { host, buildSystem, graphNode, entityCache } = await makeHarness({
      isAdmitted: (_repo, ev) => admitted.has(ev),
    });
    setAppManifestTarget(graphNode, "terminal", ["clipboard"]);
    const makeTerminalBuild = (key: string, ev: string) => ({
      buildKey: path.basename(
        path.join(path.dirname(graphNode.path), "..", "..", "state", "builds", key)
      ),
      sourceStateHash: "state:test",

      dir: path.join(path.dirname(graphNode.path), "..", "..", "state", "builds", key),
      metadata: {
        ...TEST_SEALED_APP_BUILD_METADATA,
        ev,
        sourceStateHash: `state:${ev}`,
        details: {
          kind: "app",
          target: "terminal",
          integrity: null,
          rnHostAbi: null,
          provider: null,
        },
        buildKey: path.basename(
          path.join(path.dirname(graphNode.path), "..", "..", "state", "builds", key)
        ),
      },
      artifacts: [
        storedArtifact(
          path.join(path.dirname(graphNode.path), "..", "..", "state", "builds", key),
          "index.mjs",
          "export {};\n",
          { role: "primary", contentType: "text/javascript; charset=utf-8", encoding: "utf8" }
        ),
      ],
    });
    const oldBuild = makeTerminalBuild("terminal-old", "ev-terminal-old");
    const candidateBuild = makeTerminalBuild("terminal-candidate", "ev-terminal-candidate");
    buildSystem.getStoredBuild.mockResolvedValue(candidateBuild as never);
    buildSystem.getBuildByKey.mockImplementation(async (key: string) =>
      key === "terminal-old"
        ? (oldBuild as never)
        : key === "terminal-candidate"
          ? (candidateBuild as never)
          : null
    );
    host.registry.upsert({
      unitKind: "app",
      name: graphNode.name,
      version: "1.0.0",
      target: "terminal",
      capabilities: ["clipboard"],
      source: { kind: "workspace-repo", repo: graphNode.relativePath, ref: "main" },
      installedAt: Date.now(),
      activeEv: "ev-terminal-old",
      activeSourceHash: "state:ev-terminal-old",
      activeBundleKey: "terminal-old",
      activeExecutionDigest: TEST_EXECUTION_IDENTITY.executionDigest,
      activeDependencyEvs: {},
      activeExternalDeps: {},
      activeRuntimeDepsKey: null,
      status: "running",
      lastError: null,
      previousVersions: [],
    });
    await host.activateRelease(graphNode.name);
    const priorPrincipal = entityCache.resolveActive(graphNode.name);
    expect(priorPrincipal).toMatchObject({ activeBuildKey: "terminal-old" });

    await host.reconcileDeclared([{ source: graphNode.relativePath, ref: "candidate-ref" }]);
    await host.whenSettled();

    // The candidate is reported as the entry's error; the admitted build
    // stays selected and its app entity stays active.
    expect(host.registry.get(graphNode.name)).toMatchObject({
      activeBundleKey: "terminal-old",
      activeEv: "ev-terminal-old",
      status: "error",
      lastError: expect.stringContaining("needs your review before it can run"),
    });
    expect(entityCache.resolveActive(graphNode.name)).toMatchObject({
      activeBuildKey: "terminal-old",
    });
  });

  it("rolls terminal apps back to a retained terminal build", async () => {
    const { host, buildSystem, eventService, notificationService, graphNode } = await makeHarness();
    const buildByKey = new Map([
      [
        "terminal-key-1",
        {
          buildKey: path.basename(
            path.join(path.dirname(graphNode.path), "..", "..", "state", "builds", "terminal-key-1")
          ),
          sourceStateHash: "state:test",

          dir: path.join(
            path.dirname(graphNode.path),
            "..",
            "..",
            "state",
            "builds",
            "terminal-key-1"
          ),
          metadata: {
            ...TEST_SEALED_APP_BUILD_METADATA,
            ev: "ev-terminal-1",
            sourceStateHash: "state:test",
            details: {
              kind: "app" as const,
              target: "terminal" as const,
              integrity: null,
              rnHostAbi: null,
              provider: null,
            },
            buildKey: path.basename(
              path.join(
                path.dirname(graphNode.path),
                "..",
                "..",
                "state",
                "builds",
                "terminal-key-1"
              )
            ),
          },
          artifacts: [
            storedArtifact(
              path.join(
                path.dirname(graphNode.path),
                "..",
                "..",
                "state",
                "builds",
                "terminal-key-1"
              ),
              "index.mjs",
              "export {};\n",
              { role: "primary", contentType: "text/javascript; charset=utf-8", encoding: "utf8" }
            ),
          ],
        },
      ],
      [
        "terminal-key-2",
        {
          buildKey: path.basename(
            path.join(path.dirname(graphNode.path), "..", "..", "state", "builds", "terminal-key-2")
          ),
          sourceStateHash: "state:test",

          dir: path.join(
            path.dirname(graphNode.path),
            "..",
            "..",
            "state",
            "builds",
            "terminal-key-2"
          ),
          metadata: {
            ...TEST_SEALED_APP_BUILD_METADATA,
            ev: "ev-terminal-2",
            sourceStateHash: "state:test",
            details: {
              kind: "app" as const,
              target: "terminal" as const,
              integrity: null,
              rnHostAbi: null,
              provider: null,
            },
            buildKey: path.basename(
              path.join(
                path.dirname(graphNode.path),
                "..",
                "..",
                "state",
                "builds",
                "terminal-key-2"
              )
            ),
          },
          artifacts: [
            storedArtifact(
              path.join(
                path.dirname(graphNode.path),
                "..",
                "..",
                "state",
                "builds",
                "terminal-key-2"
              ),
              "index.mjs",
              "export {};\n",
              { role: "primary", contentType: "text/javascript; charset=utf-8", encoding: "utf8" }
            ),
          ],
        },
      ],
    ]);
    buildSystem.getBuildByKey.mockImplementation(
      async (key: string) => (buildByKey.get(key) ?? null) as never
    );
    host.registry.upsert({
      unitKind: "app",
      name: graphNode.name,
      version: "1.0.0",
      target: "terminal",
      capabilities: ["clipboard"],
      source: { kind: "workspace-repo", repo: graphNode.relativePath, ref: "main" },
      installedAt: Date.now(),
      activeEv: "ev-terminal-2",
      activeSourceHash: "sha-2",
      activeBundleKey: "terminal-key-2",
      activeExecutionDigest: TEST_EXECUTION_IDENTITY.executionDigest,
      activeDependencyEvs: {},
      activeExternalDeps: {},
      activeRuntimeDepsKey: null,
      status: "available",
      lastError: null,
      previousVersions: [
        {
          version: "1.0.0",
          target: "terminal",
          capabilities: ["clipboard"],
          activeEv: "ev-terminal-1",
          activeSourceHash: "sha-1",
          activeBundleKey: "terminal-key-1",
          executionDigest: TEST_EXECUTION_IDENTITY.executionDigest,
          activeDependencyEvs: {},
          activeExternalDeps: {},
          activeRuntimeDepsKey: null,
          activatedAt: Date.now() - 1000,
        },
      ],
    });

    await host.rollbackAppVersion(graphNode.name);

    expect(host.registry.get(graphNode.name)).toMatchObject({
      target: "terminal",
      status: "running",
      activeBundleKey: "terminal-key-1",
      activeEv: "ev-terminal-1",
      previousVersions: [
        expect.objectContaining({ activeBundleKey: "terminal-key-2", activeEv: "ev-terminal-2" }),
      ],
    });
    expect(eventService.emit).toHaveBeenCalledWith(
      "supervision:changed",
      expect.objectContaining({
        change: "rolled-back",
        identity: { kind: "app", entityId: graphNode.name },
        artifact: expect.objectContaining({ buildKey: "terminal-key-1" }),
        adoption: "artifact-only",
        app: expect.objectContaining({ target: "terminal" }),
      })
    );
    expect(notificationService.show).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Terminal app update available",
        message: expect.stringContaining("Restart `vibestudio terminal`"),
      })
    );
    const notification = (notificationService.show.mock.calls as unknown as unknown[][]).at(
      -1
    )?.[0] as { actions?: Array<{ id: string }> };
    expect(notification.actions?.map((action) => action.id)).not.toContain(
      "runtime.supervision.restart"
    );
  });

  it("takes a unit the designated template shipped as a host-build unit", async () => {
    // Skipping the workspace admission review is what lets the shell render a
    // review at all; without it the shell waits on a decision only it can show.
    const { host } = await makeHarness({ seeded: true });
    const declared = [{ source: "apps/shell", ref: "main" }];

    expect((await host.seedTrustedDeclared(declared)).map((unit) => unit.source.repo)).toEqual([
      "apps/shell",
    ]);
  });

  it("stops taking it as a host-build unit once its source is edited", async () => {
    const { host, workspacePath } = await makeHarness({ seeded: true });
    const declared = [{ source: "apps/shell", ref: "main" }];

    fs.writeFileSync(path.join(workspacePath, "apps/shell/index.tsx"), "export default 1;\n");

    expect(await host.seedTrustedDeclared(declared)).toEqual([]);
  });

  it("still prompts for exact product-seeded app source", async () => {
    const { host, buildSystem, eventService, approvalQueue } = await makeHarness({ seeded: true });

    await host.reconcileDeclared([{ source: "apps/shell", ref: "main" }]);
    await host.whenSettled();

    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "unit-install-review",
        mode: "adopt-root",
        units: [
          expect.objectContaining({
            unitKind: "app",
            unitName: "@workspace-apps/shell",
            source: { kind: "workspace-repo", repo: "apps/shell", ref: "main" },
          }),
        ],
      })
    );
    expect(buildSystem.getStoredBuild).toHaveBeenCalledWith("@workspace-apps/shell", "main");
    expect(host.registry.get("@workspace-apps/shell")).toMatchObject({
      unitKind: "app",
      activeBundleKey: "app-key",
      status: "available",
    });
    expect(eventService.emit).not.toHaveBeenCalledWith(
      "supervision:changed",
      expect.objectContaining({ change: "adopted" })
    );
  });

  it("previews and applies React Native provider changes from trusted main", async () => {
    const { host, buildSystem, eventService, approvalQueue, graphNode } = await makeHarness({
      readWorkspaceFileAtState: async (_stateHash: string, filePath: string) =>
        filePath === "meta/vibestudio.yml"
          ? `systemEpoch: ${WORKSPACE_SYSTEM_EPOCH}\napps:\n  - source: apps/shell\n`
          : null,
      reactNativeAppArtifactBaseUrl: "https://mobile.gateway.test",
    });
    setAppManifestTarget(graphNode, "react-native", ["notifications"]);
    installApp(host, graphNode);
    host.registry.patch(graphNode.name, {
      target: "react-native",
      activeExternalDeps: {
        "build-provider:@workspace-extensions/react-native":
          "ev-provider-old:provider-build-old:vibestudio-build-provider-v1",
      },
    });
    const provider = {
      name: "@workspace-extensions/react-native",
      activeEv: "ev-provider-new",
      activeBuildKey: "provider-build-new",
      contractVersion: "vibestudio-build-provider-v1",
    };
    buildSystem.getBuildProviderDetails.mockReturnValue(provider);
    const approval = await host.unitChangeApprovalForCommit("state:provider-change");
    expect(approval.units).toEqual([
      expect.objectContaining({
        unitKind: "app",
        target: "react-native",
        provider,
        externalDeps: expect.objectContaining({
          "build-provider:@workspace-extensions/react-native":
            "ev-provider-new:provider-build-new:vibestudio-build-provider-v1",
        }),
      }),
    ]);

    const rnBuild = {
      buildKey: path.basename(
        path.join(path.dirname(graphNode.path), "..", "..", "state", "builds", "rn-app-key")
      ),
      sourceStateHash: "state:test",

      dir: path.join(path.dirname(graphNode.path), "..", "..", "state", "builds", "rn-app-key"),
      metadata: {
        ...TEST_SEALED_APP_BUILD_METADATA,
        ev: "ev-app",
        sourceStateHash: "state:test",
        details: {
          kind: "app",
          target: "react-native",
          integrity: "sha256-rn-app",
          rnHostAbi: "rn-host-2",
          provider,
        },
        buildKey: path.basename(
          path.join(path.dirname(graphNode.path), "..", "..", "state", "builds", "rn-app-key")
        ),
      },
      artifacts: [
        storedArtifact(
          path.join(path.dirname(graphNode.path), "..", "..", "state", "builds", "rn-app-key"),
          "index.android.bundle",
          "android bundle",
          {
            role: "primary",
            contentType: "application/javascript; charset=utf-8",
            encoding: "utf8",
            platform: "android",
          }
        ),
        storedArtifact(
          path.join(path.dirname(graphNode.path), "..", "..", "state", "builds", "rn-app-key"),
          "index.ios.bundle",
          "ios bundle",
          {
            role: "primary",
            contentType: "application/javascript; charset=utf-8",
            encoding: "utf8",
            platform: "ios",
          }
        ),
      ],
    };
    buildSystem.getStoredBuild.mockResolvedValueOnce(rnBuild as never);
    buildSystem.getBuildByKey.mockImplementation(async (key: string) =>
      key === "rn-app-key" ? (rnBuild as never) : null
    );

    await host.reconcileDeclared([
      {
        source: graphNode.relativePath,
        ref: "main",
      },
    ]);
    await host.whenSettled();
    await host.activateRelease(graphNode.name);

    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "unit-install-review",
        mode: "adopt-root",
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
          "ev-provider-new:provider-build-new:vibestudio-build-provider-v1",
      },
    });
    expect(eventService.emit).toHaveBeenCalledWith(
      "supervision:changed",
      expect.objectContaining({
        change: "adopted",
        artifact: expect.objectContaining({ buildKey: "rn-app-key" }),
        adoption: "immediate",
        app: expect.objectContaining({
          target: "react-native",
          artifactRoute: "/_a/rn-app-key/index.android.bundle",
        }),
      })
    );
    expect(await host.reactNative.getBootstrap(graphNode.relativePath)).toMatchObject({
      appId: "@workspace-apps/shell",
      buildKey: "rn-app-key",
      capabilities: ["notifications"],
      rnHostAbi: "rn-host-2",
      integrity: "sha256-rn-app",
      artifacts: expect.arrayContaining([
        expect.objectContaining({
          path: "index.android.bundle",
          platform: "android",
          integrity: `sha256-${createHash("sha256").update("android bundle").digest("hex")}`,
          route: "/_a/rn-app-key/index.android.bundle",
          url: "https://mobile.gateway.test/_a/rn-app-key/index.android.bundle",
        }),
        expect.objectContaining({
          path: "index.ios.bundle",
          platform: "ios",
          integrity: `sha256-${createHash("sha256").update("ios bundle").digest("hex")}`,
          route: "/_a/rn-app-key/index.ios.bundle",
          url: "https://mobile.gateway.test/_a/rn-app-key/index.ios.bundle",
        }),
      ]),
      provider,
    });
  });

  it("defers trusted React Native provider changes until mobile readiness is requested", async () => {
    const { host, buildSystem, approvalQueue, graphNode, providerChangeCallbacks } =
      await makeHarness({
        readWorkspaceFileAtState: async (_stateHash: string, filePath: string) =>
          filePath === "meta/vibestudio.yml"
            ? `systemEpoch: ${WORKSPACE_SYSTEM_EPOCH}\napps:\n  - source: apps/shell\n`
            : null,
      });
    setAppManifestTarget(graphNode, "react-native", ["notifications"]);
    installApp(host, graphNode);
    host.registry.patch(graphNode.name, {
      target: "react-native",
      activeExternalDeps: {
        "build-provider:@workspace-extensions/react-native":
          "ev-provider-old:provider-build-old:vibestudio-build-provider-v1",
      },
    });
    const oldProvider = {
      name: "@workspace-extensions/react-native",
      activeEv: "ev-provider-old",
      activeBuildKey: "provider-build-old",
      contractVersion: "vibestudio-build-provider-v1",
    };
    const newProvider = {
      name: "@workspace-extensions/react-native",
      activeEv: "ev-provider-new",
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
    buildSystem.getStoredBuild.mockClear();
    buildSystem.getBuildProviderDetails.mockReturnValue(newProvider);

    providerChangeCallbacks[0]?.({
      type: "registered",
      target: "react-native",
      provider: newProvider,
    });
    await flushAsyncWork();
    await host.whenSettled();

    expect(approvalQueue.request).not.toHaveBeenCalled();
    expect(buildSystem.getStoredBuild).not.toHaveBeenCalled();
    expect(host.registry.get(graphNode.name)?.activeBundleKey).toBe("app-key");
    const approval = await host.unitChangeApprovalForCommit("state:provider-change");
    expect(approval.units).toEqual([
      expect.objectContaining({
        provider: newProvider,
        externalDeps: expect.objectContaining({
          "build-provider:@workspace-extensions/react-native":
            "ev-provider-new:provider-build-new:vibestudio-build-provider-v1",
        }),
      }),
    ]);

    const providerChangeBuild = {
      buildKey: path.basename(
        path.join(
          path.dirname(graphNode.path),
          "..",
          "..",
          "state",
          "builds",
          "rn-provider-change-key"
        )
      ),
      sourceStateHash: "state:test",

      dir: path.join(
        path.dirname(graphNode.path),
        "..",
        "..",
        "state",
        "builds",
        "rn-provider-change-key"
      ),
      metadata: {
        ...TEST_SEALED_APP_BUILD_METADATA,
        ev: "ev-app",
        sourceStateHash: "state:test",
        details: {
          kind: "app",
          target: "react-native",
          integrity: "sha256-rn-app",
          rnHostAbi: "rn-host-2",
          provider: newProvider,
        },
        buildKey: path.basename(
          path.join(
            path.dirname(graphNode.path),
            "..",
            "..",
            "state",
            "builds",
            "rn-provider-change-key"
          )
        ),
      },
      artifacts: [
        storedArtifact(
          path.join(
            path.dirname(graphNode.path),
            "..",
            "..",
            "state",
            "builds",
            "rn-provider-change-key"
          ),
          "index.android.bundle",
          "android bundle",
          {
            role: "primary",
            contentType: "application/javascript; charset=utf-8",
            encoding: "utf8",
            platform: "android",
          }
        ),
        storedArtifact(
          path.join(
            path.dirname(graphNode.path),
            "..",
            "..",
            "state",
            "builds",
            "rn-provider-change-key"
          ),
          "index.ios.bundle",
          "ios bundle",
          {
            role: "primary",
            contentType: "application/javascript; charset=utf-8",
            encoding: "utf8",
            platform: "ios",
          }
        ),
      ],
    };
    buildSystem.getStoredBuild.mockResolvedValueOnce(providerChangeBuild as never);
    const activeBuild = {
      ...providerChangeBuild,
      buildKey: "app-key",
      metadata: {
        ...providerChangeBuild.metadata,
        buildKey: "app-key",
        sourcePath: "apps/shell",
        details: {
          ...providerChangeBuild.metadata.details,
          provider: oldProvider,
        },
      },
    };
    buildSystem.getBuildByKey.mockImplementation(async (key: string) =>
      key === "rn-provider-change-key"
        ? (providerChangeBuild as never)
        : key === "app-key"
          ? (activeBuild as never)
          : null
    );

    const prepared = await host.reactNative.ensureReady(graphNode.relativePath);

    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "unit-install-review",
        mode: "adopt-root",
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
    expect(prepared).toMatchObject({
      ready: false,
      source: graphNode.relativePath,
      appId: graphNode.name,
    });
    expect(host.registry.get(graphNode.name)?.activeBundleKey).toBe("rn-provider-change-key");
    await host.activateRelease(graphNode.name);
    await expect(host.reactNative.ensureReady(graphNode.relativePath)).resolves.toMatchObject({
      ready: true,
      buildKey: "rn-provider-change-key",
    });
  });

  it("stages React Native app approval before the provider is active and consumes it after provider startup", async () => {
    const prepareHostTarget = vi.fn(async () => undefined);
    const { host, buildSystem, approvalQueue, approvalCoordinator, graphNode } = await makeHarness({
      useApprovalCoordinator: true,
      prepareHostTarget,
    });
    setAppManifestTarget(graphNode, "react-native", ["notifications"]);
    host.setDeclared([{ source: graphNode.relativePath, ref: "main" }]);

    const waitingForProvider = await host.reactNative.ensureReady(graphNode.relativePath, {
      waitForApproval: false,
    });

    expect(waitingForProvider).toMatchObject({
      ready: false,
      source: graphNode.relativePath,
      appId: graphNode.name,
      reason: "React Native build provider is not active",
    });
    expect(prepareHostTarget).toHaveBeenCalledWith("react-native");
    expect(buildSystem.getStoredBuild).not.toHaveBeenCalled();
    expect(approvalQueue.request).not.toHaveBeenCalled();

    approvalCoordinator?.publishPending("startup");
    await flushAsyncWork();
    await flushAsyncWork();

    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "unit-install-review",
        mode: "adopt-root",
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
      activeEv: "ev-provider",
      activeBuildKey: "provider-build",
      contractVersion: "vibestudio-build-provider-v1",
    };
    const rnBuild = {
      buildKey: path.basename(
        path.join(path.dirname(graphNode.path), "..", "..", "state", "builds", "rn-preflight-key")
      ),
      sourceStateHash: "state:test",

      dir: path.join(
        path.dirname(graphNode.path),
        "..",
        "..",
        "state",
        "builds",
        "rn-preflight-key"
      ),
      metadata: {
        ...TEST_SEALED_APP_BUILD_METADATA,
        ev: "ev-app",
        sourceStateHash: "state:test",
        details: {
          kind: "app",
          target: "react-native",
          integrity: "sha256-rn-app",
          rnHostAbi: "rn-host-2",
          provider,
        },
        buildKey: path.basename(
          path.join(path.dirname(graphNode.path), "..", "..", "state", "builds", "rn-preflight-key")
        ),
      },
      artifacts: [
        storedArtifact(
          path.join(
            path.dirname(graphNode.path),
            "..",
            "..",
            "state",
            "builds",
            "rn-preflight-key"
          ),
          "index.android.bundle",
          "android bundle",
          {
            role: "primary",
            contentType: "application/javascript; charset=utf-8",
            encoding: "utf8",
            platform: "android",
          }
        ),
      ],
    };
    buildSystem.getBuildProviderDetails.mockReturnValue(provider);
    buildSystem.getStoredBuild.mockResolvedValueOnce(rnBuild as never);
    buildSystem.getBuildByKey.mockImplementation(async (key: string) =>
      key === "rn-preflight-key" ? (rnBuild as never) : null
    );

    const prepared = await host.reactNative.ensureReady(graphNode.relativePath);

    expect(approvalQueue.request).not.toHaveBeenCalled();
    expect(prepared).toMatchObject({
      ready: false,
      source: graphNode.relativePath,
      appId: graphNode.name,
    });
    expect(host.registry.get(graphNode.name)).toMatchObject({
      status: "available",
      activeBundleKey: "rn-preflight-key",
    });
    await host.activateRelease(graphNode.name);
    await expect(host.reactNative.ensureReady(graphNode.relativePath)).resolves.toMatchObject({
      ready: true,
      buildKey: "rn-preflight-key",
    });
  });

  it("does not restage React Native approval for an unchanged trusted app while provider starts", async () => {
    const { host, buildSystem, approvalQueue, approvalCoordinator, graphNode } = await makeHarness({
      useApprovalCoordinator: true,
    });
    setAppManifestTarget(graphNode, "react-native", ["notifications"]);
    const provider = {
      name: "@workspace-extensions/react-native",
      activeEv: "ev-provider",
      activeBuildKey: "provider-build",
      contractVersion: "vibestudio-build-provider-v1",
    };
    const providerDep = {
      [`build-provider:${provider.name}`]:
        "ev-provider:provider-build:vibestudio-build-provider-v1",
    };
    installAppEntry(host, graphNode, {
      target: "react-native",
      activeBundleKey: "rn-existing-key",
      activeExecutionDigest: TEST_EXECUTION_IDENTITY.executionDigest,
      activeEv: "ev-app",
      capabilities: ["notifications"],
    });
    host.registry.patch(graphNode.name, { activeExternalDeps: providerDep });
    const rnBuild = {
      buildKey: path.basename(
        path.join(path.dirname(graphNode.path), "..", "..", "state", "builds", "rn-existing-key")
      ),
      sourceStateHash: "state:test",

      dir: path.join(
        path.dirname(graphNode.path),
        "..",
        "..",
        "state",
        "builds",
        "rn-existing-key"
      ),
      metadata: {
        ...TEST_SEALED_APP_BUILD_METADATA,
        ev: "ev-app",
        sourceStateHash: "state:test",
        details: {
          kind: "app",
          target: "react-native",
          integrity: "sha256-rn-app",
          rnHostAbi: "rn-host-2",
          provider,
        },
        buildKey: path.basename(
          path.join(path.dirname(graphNode.path), "..", "..", "state", "builds", "rn-existing-key")
        ),
      },
      artifacts: [
        storedArtifact(
          path.join(path.dirname(graphNode.path), "..", "..", "state", "builds", "rn-existing-key"),
          "index.android.bundle",
          "android bundle",
          {
            role: "primary",
            contentType: "application/javascript; charset=utf-8",
            encoding: "utf8",
            platform: "android",
          }
        ),
      ],
    };
    buildSystem.getBuildByKey.mockImplementation(async (key: string) =>
      key === "rn-existing-key" ? (rnBuild as never) : null
    );
    buildSystem.getBuildProviderDetails.mockReturnValue(null);

    await host.reconcileDeclared([{ source: graphNode.relativePath, ref: "main" }]);
    await host.whenSettled();
    approvalCoordinator?.publishPending("startup");
    await flushAsyncWork();

    expect(approvalQueue.request).not.toHaveBeenCalled();
    expect(buildSystem.getStoredBuild).not.toHaveBeenCalled();
    expect(host.registry.get(graphNode.name)).toMatchObject({
      status: "running",
      activeBundleKey: "rn-existing-key",
      activeExternalDeps: providerDep,
    });
  });

  it("defers React Native builds cleanly until the provider starts", async () => {
    const { host, buildSystem, graphNode } = await makeHarness();
    setAppManifestTarget(graphNode, "react-native", ["notifications"]);

    await host.reconcileDeclared([{ source: graphNode.relativePath, ref: "main" }]);
    await host.whenSettled();
    expect(host.registry.get(graphNode.name)).toMatchObject({
      status: "stopped",
      lastError: null,
    });
    expect(buildSystem.getStoredBuild).not.toHaveBeenCalled();

    const provider = {
      name: "@workspace-extensions/react-native",
      activeEv: "ev-provider",
      activeBuildKey: "provider-build",
      contractVersion: "vibestudio-build-provider-v1",
    };
    const rnBuild = {
      buildKey: path.basename(
        path.join(path.dirname(graphNode.path), "..", "..", "state", "builds", "rn-ready-key")
      ),
      sourceStateHash: "state:test",

      dir: path.join(path.dirname(graphNode.path), "..", "..", "state", "builds", "rn-ready-key"),
      metadata: {
        ...TEST_SEALED_APP_BUILD_METADATA,
        ev: "ev-app",
        sourceStateHash: "state:test",
        details: {
          kind: "app",
          target: "react-native",
          integrity: "sha256-rn-app",
          rnHostAbi: "rn-host-2",
          provider,
        },
        buildKey: path.basename(
          path.join(path.dirname(graphNode.path), "..", "..", "state", "builds", "rn-ready-key")
        ),
      },
      artifacts: [
        storedArtifact(
          path.join(path.dirname(graphNode.path), "..", "..", "state", "builds", "rn-ready-key"),
          "index.android.bundle",
          "android bundle",
          {
            role: "primary",
            contentType: "application/javascript; charset=utf-8",
            encoding: "utf8",
            platform: "android",
          }
        ),
      ],
    };
    buildSystem.getBuildProviderDetails.mockReturnValue(provider);
    buildSystem.getStoredBuild.mockResolvedValueOnce(rnBuild as never);
    buildSystem.getBuildByKey.mockImplementation(async (key: string) =>
      key === "rn-ready-key" ? (rnBuild as never) : null
    );

    const prepared = await host.reactNative.ensureReady(graphNode.relativePath);

    expect(prepared).toMatchObject({
      ready: false,
      source: graphNode.relativePath,
      appId: graphNode.name,
    });
    expect(host.registry.get(graphNode.name)).toMatchObject({
      status: "available",
      activeBundleKey: "rn-ready-key",
    });
    await host.activateRelease(graphNode.name);
    await expect(host.reactNative.ensureReady(graphNode.relativePath)).resolves.toMatchObject({
      ready: true,
      buildKey: "rn-ready-key",
    });
  });

  it("recovers deferred React Native readiness once the provider build is available", async () => {
    const { host, buildSystem, graphNode } = await makeHarness();
    setAppManifestTarget(graphNode, "react-native", ["notifications"]);

    await host.reconcileDeclared([{ source: graphNode.relativePath, ref: "main" }]);
    await host.whenSettled();
    expect(host.registry.get(graphNode.name)).toMatchObject({
      status: "stopped",
      lastError: null,
    });
    expect(buildSystem.getStoredBuild).not.toHaveBeenCalled();

    const provider = {
      name: "@workspace-extensions/react-native",
      activeEv: "ev-provider",
      activeBuildKey: "provider-build",
      contractVersion: "vibestudio-build-provider-v1",
    };
    const rnBuild = {
      buildKey: path.basename(
        path.join(path.dirname(graphNode.path), "..", "..", "state", "builds", "rn-delayed-key")
      ),
      sourceStateHash: "state:test",

      dir: path.join(path.dirname(graphNode.path), "..", "..", "state", "builds", "rn-delayed-key"),
      metadata: {
        ...TEST_SEALED_APP_BUILD_METADATA,
        ev: "ev-app",
        sourceStateHash: "state:test",
        details: {
          kind: "app",
          target: "react-native",
          integrity: "sha256-rn-app",
          rnHostAbi: "rn-host-2",
          provider,
        },
        buildKey: path.basename(
          path.join(path.dirname(graphNode.path), "..", "..", "state", "builds", "rn-delayed-key")
        ),
      },
      artifacts: [
        storedArtifact(
          path.join(path.dirname(graphNode.path), "..", "..", "state", "builds", "rn-delayed-key"),
          "index.android.bundle",
          "android bundle",
          {
            role: "primary",
            contentType: "application/javascript; charset=utf-8",
            encoding: "utf8",
            platform: "android",
          }
        ),
      ],
    };
    buildSystem.getBuildProviderDetails.mockReturnValue(provider);
    buildSystem.getStoredBuild.mockResolvedValueOnce(rnBuild as never);
    buildSystem.getBuildByKey.mockImplementation(async (key: string) =>
      key === "rn-delayed-key" ? (rnBuild as never) : null
    );

    const prepared = await host.reactNative.ensureReady(graphNode.relativePath);

    expect(prepared).toMatchObject({
      ready: false,
      source: graphNode.relativePath,
      appId: graphNode.name,
    });
    await host.activateRelease(graphNode.name);
    await expect(host.reactNative.ensureReady(graphNode.relativePath)).resolves.toMatchObject({
      ready: true,
      buildKey: "rn-delayed-key",
    });
  });

  it("does not produce React Native bootstrap for platformless primary artifacts", async () => {
    const { host, buildSystem, graphNode } = await makeHarness();
    installApp(host, graphNode);
    host.registry.patch(graphNode.name, {
      target: "react-native",
      source: { kind: "workspace-repo", repo: "apps/mobile", ref: "main" },
      activeEv: "ev-mobile",
      activeBundleKey: "rn-platformless-key",
      activeExecutionDigest: TEST_EXECUTION_IDENTITY.executionDigest,
      capabilities: ["notifications"],
    });
    buildSystem.getBuildByKey.mockImplementation(async (key: string) =>
      key === "rn-platformless-key"
        ? ({
            buildKey: path.basename(
              path.join(
                path.dirname(graphNode.path),
                "..",
                "..",
                "state",
                "builds",
                "rn-platformless-key"
              )
            ),
            sourceStateHash: "state:test",

            dir: path.join(
              path.dirname(graphNode.path),
              "..",
              "..",
              "state",
              "builds",
              "rn-platformless-key"
            ),
            metadata: {
              ...TEST_SEALED_APP_BUILD_METADATA,
              ev: "ev-mobile",
              sourceStateHash: "state:test",
              details: {
                kind: "app",
                target: "react-native",
                integrity: "sha256-rn-app",
                rnHostAbi: "rn-host-2",
                provider: REACT_NATIVE_PROVIDER,
              },
              buildKey: path.basename(
                path.join(
                  path.dirname(graphNode.path),
                  "..",
                  "..",
                  "state",
                  "builds",
                  "rn-platformless-key"
                )
              ),
            },
            artifacts: [
              storedArtifact(
                path.join(
                  path.dirname(graphNode.path),
                  "..",
                  "..",
                  "state",
                  "builds",
                  "rn-platformless-key"
                ),
                "index.bundle",
                "bundle",
                {
                  role: "primary",
                  contentType: "application/javascript; charset=utf-8",
                  encoding: "utf8",
                }
              ),
            ],
          } as never)
        : null
    );

    expect(await host.reactNative.getBootstrap("apps/mobile")).toBeNull();
  });

  it("produces React Native bootstrap for platform-specific mobile builds", async () => {
    const { host, buildSystem, graphNode } = await makeHarness({
      reactNativeAppArtifactBaseUrl: "https://host.tailnet.ts.net",
    });
    installApp(host, graphNode);
    host.registry.patch(graphNode.name, {
      target: "react-native",
      source: { kind: "workspace-repo", repo: "apps/mobile", ref: "main" },
      activeEv: "ev-mobile",
      activeBundleKey: "rn-android-only-key",
      activeExecutionDigest: TEST_EXECUTION_IDENTITY.executionDigest,
      capabilities: ["notifications"],
    });
    buildSystem.getBuildByKey.mockImplementation(async (key: string) =>
      key === "rn-android-only-key"
        ? ({
            buildKey: path.basename(
              path.join(
                path.dirname(graphNode.path),
                "..",
                "..",
                "state",
                "builds",
                "rn-android-only-key"
              )
            ),
            sourceStateHash: "state:test",

            dir: path.join(
              path.dirname(graphNode.path),
              "..",
              "..",
              "state",
              "builds",
              "rn-android-only-key"
            ),
            metadata: {
              ...TEST_SEALED_APP_BUILD_METADATA,
              ev: "ev-mobile",
              sourceStateHash: "state:test",
              details: {
                kind: "app",
                target: "react-native",
                integrity: "sha256-rn-app",
                rnHostAbi: "rn-host-2",
                provider: REACT_NATIVE_PROVIDER,
              },
              buildKey: path.basename(
                path.join(
                  path.dirname(graphNode.path),
                  "..",
                  "..",
                  "state",
                  "builds",
                  "rn-android-only-key"
                )
              ),
            },
            artifacts: [
              storedArtifact(
                path.join(
                  path.dirname(graphNode.path),
                  "..",
                  "..",
                  "state",
                  "builds",
                  "rn-android-only-key"
                ),
                "index.android.bundle",
                "bundle",
                {
                  role: "primary",
                  contentType: "application/javascript; charset=utf-8",
                  encoding: "utf8",
                  platform: "android",
                }
              ),
              storedArtifact(
                path.join(
                  path.dirname(graphNode.path),
                  "..",
                  "..",
                  "state",
                  "builds",
                  "rn-android-only-key"
                ),
                "android/drawable-mdpi/logo.png",
                "image",
                { role: "asset", contentType: "image/png", encoding: "base64", platform: "android" }
              ),
            ],
          } as never)
        : null
    );

    expect(await host.reactNative.getBootstrap("apps/mobile")).toMatchObject({
      buildKey: "rn-android-only-key",
      artifacts: [
        expect.objectContaining({
          path: "index.android.bundle",
          platform: "android",
          integrity: `sha256-${createHash("sha256").update("bundle").digest("hex")}`,
          route: "/_a/rn-android-only-key/index.android.bundle",
          url: "https://host.tailnet.ts.net/_a/rn-android-only-key/index.android.bundle",
        }),
        expect.objectContaining({
          path: "android/drawable-mdpi/logo.png",
          platform: "android",
          role: "asset",
          integrity: `sha256-${createHash("sha256").update("image").digest("hex")}`,
          url: "https://host.tailnet.ts.net/_a/rn-android-only-key/android/drawable-mdpi/logo.png",
        }),
      ],
    });
  });

  it("does not produce React Native bootstrap without provider identity", async () => {
    const { host, buildSystem, graphNode } = await makeHarness();
    installApp(host, graphNode);
    host.registry.patch(graphNode.name, {
      target: "react-native",
      source: { kind: "workspace-repo", repo: "apps/mobile", ref: "main" },
      activeEv: "ev-mobile",
      activeBundleKey: "rn-no-provider-key",
      activeExecutionDigest: TEST_EXECUTION_IDENTITY.executionDigest,
      capabilities: ["notifications"],
    });
    buildSystem.getBuildByKey.mockImplementation(async (key: string) =>
      key === "rn-no-provider-key"
        ? ({
            buildKey: path.basename(
              path.join(
                path.dirname(graphNode.path),
                "..",
                "..",
                "state",
                "builds",
                "rn-no-provider-key"
              )
            ),
            sourceStateHash: "state:test",

            dir: path.join(
              path.dirname(graphNode.path),
              "..",
              "..",
              "state",
              "builds",
              "rn-no-provider-key"
            ),
            metadata: {
              ...TEST_SEALED_APP_BUILD_METADATA,
              ev: "ev-mobile",
              sourceStateHash: "state:test",
              details: {
                kind: "app",
                target: "react-native",
                integrity: "sha256-rn-app",
                rnHostAbi: "rn-host-2",
                provider: null,
              },
              buildKey: path.basename(
                path.join(
                  path.dirname(graphNode.path),
                  "..",
                  "..",
                  "state",
                  "builds",
                  "rn-no-provider-key"
                )
              ),
            },
            artifacts: [
              storedArtifact(
                path.join(
                  path.dirname(graphNode.path),
                  "..",
                  "..",
                  "state",
                  "builds",
                  "rn-no-provider-key"
                ),
                "index.android.bundle",
                "android bundle",
                {
                  role: "primary",
                  contentType: "application/javascript; charset=utf-8",
                  encoding: "utf8",
                  platform: "android",
                }
              ),
              storedArtifact(
                path.join(
                  path.dirname(graphNode.path),
                  "..",
                  "..",
                  "state",
                  "builds",
                  "rn-no-provider-key"
                ),
                "index.ios.bundle",
                "ios bundle",
                {
                  role: "primary",
                  contentType: "application/javascript; charset=utf-8",
                  encoding: "utf8",
                  platform: "ios",
                }
              ),
            ],
          } as never)
        : null
    );

    expect(await host.reactNative.getBootstrap("apps/mobile")).toBeNull();
  });

  it("fails closed before activating React Native builds without provider identity", async () => {
    const { host, buildSystem, eventService, graphNode } = await makeHarness();
    setAppManifestTarget(graphNode, "react-native", ["notifications"]);
    buildSystem.getBuildProviderDetails.mockReturnValue(REACT_NATIVE_PROVIDER);
    const rnBuild = {
      buildKey: path.basename(
        path.join(path.dirname(graphNode.path), "..", "..", "state", "builds", "rn-no-provider-key")
      ),
      sourceStateHash: "state:test",

      dir: path.join(
        path.dirname(graphNode.path),
        "..",
        "..",
        "state",
        "builds",
        "rn-no-provider-key"
      ),
      metadata: {
        ...TEST_SEALED_APP_BUILD_METADATA,
        ev: "ev-app",
        sourceStateHash: "state:test",
        details: {
          kind: "app",
          target: "react-native",
          integrity: "sha256-rn-app",
          rnHostAbi: "rn-host-2",
          provider: null,
        },
        buildKey: path.basename(
          path.join(
            path.dirname(graphNode.path),
            "..",
            "..",
            "state",
            "builds",
            "rn-no-provider-key"
          )
        ),
      },
      artifacts: [
        storedArtifact(
          path.join(
            path.dirname(graphNode.path),
            "..",
            "..",
            "state",
            "builds",
            "rn-no-provider-key"
          ),
          "index.android.bundle",
          "android bundle",
          {
            role: "primary",
            contentType: "application/javascript; charset=utf-8",
            encoding: "utf8",
            platform: "android",
          }
        ),
        storedArtifact(
          path.join(
            path.dirname(graphNode.path),
            "..",
            "..",
            "state",
            "builds",
            "rn-no-provider-key"
          ),
          "index.ios.bundle",
          "ios bundle",
          {
            role: "primary",
            contentType: "application/javascript; charset=utf-8",
            encoding: "utf8",
            platform: "ios",
          }
        ),
      ],
    };
    buildSystem.getStoredBuild.mockResolvedValueOnce(rnBuild as never);

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
      "supervision:changed",
      expect.objectContaining({
        change: "adopted",
        app: expect.objectContaining({ target: "react-native" }),
      })
    );
  });

  it("fails closed before activating React Native builds without platform-keyed primary artifacts", async () => {
    const { host, buildSystem, eventService, graphNode } = await makeHarness();
    setAppManifestTarget(graphNode, "react-native", ["notifications"]);
    buildSystem.getBuildProviderDetails.mockReturnValue(REACT_NATIVE_PROVIDER);
    const rnBuild = {
      buildKey: path.basename(
        path.join(path.dirname(graphNode.path), "..", "..", "state", "builds", "rn-bad-key")
      ),
      sourceStateHash: "state:test",

      dir: path.join(path.dirname(graphNode.path), "..", "..", "state", "builds", "rn-bad-key"),
      metadata: {
        ...TEST_SEALED_APP_BUILD_METADATA,
        ev: "ev-app",
        sourceStateHash: "state:test",
        details: {
          kind: "app",
          target: "react-native",
          integrity: "sha256-rn-app",
          rnHostAbi: "rn-host-2",
          provider: REACT_NATIVE_PROVIDER,
        },
        buildKey: path.basename(
          path.join(path.dirname(graphNode.path), "..", "..", "state", "builds", "rn-bad-key")
        ),
      },
      artifacts: [
        storedArtifact(
          path.join(path.dirname(graphNode.path), "..", "..", "state", "builds", "rn-bad-key"),
          "index.bundle",
          "bundle",
          {
            role: "primary",
            contentType: "application/javascript; charset=utf-8",
            encoding: "utf8",
          }
        ),
      ],
    };
    buildSystem.getStoredBuild.mockResolvedValueOnce(rnBuild as never);

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
      "supervision:changed",
      expect.objectContaining({
        change: "adopted",
        app: expect.objectContaining({ target: "react-native" }),
      })
    );
  });

  ledgerTest("execution.react-native-app", async () => {
    const { host, buildSystem, graphNode } = await makeHarness();
    setAppManifestTarget(graphNode, "react-native", ["notifications"]);
    buildSystem.getBuildProviderDetails.mockReturnValue(REACT_NATIVE_PROVIDER);
    const rnBuild = {
      buildKey: path.basename(
        path.join(
          path.dirname(graphNode.path),
          "..",
          "..",
          "state",
          "builds",
          "rn-android-only-key"
        )
      ),
      sourceStateHash: "state:test",

      dir: path.join(
        path.dirname(graphNode.path),
        "..",
        "..",
        "state",
        "builds",
        "rn-android-only-key"
      ),
      metadata: {
        ...TEST_SEALED_APP_BUILD_METADATA,
        ev: "ev-app",
        sourceStateHash: "state:test",
        details: {
          kind: "app",
          target: "react-native",
          integrity: "sha256-rn-app",
          rnHostAbi: "rn-host-2",
          provider: REACT_NATIVE_PROVIDER,
        },
        buildKey: path.basename(
          path.join(
            path.dirname(graphNode.path),
            "..",
            "..",
            "state",
            "builds",
            "rn-android-only-key"
          )
        ),
      },
      artifacts: [
        storedArtifact(
          path.join(
            path.dirname(graphNode.path),
            "..",
            "..",
            "state",
            "builds",
            "rn-android-only-key"
          ),
          "index.android.bundle",
          "bundle",
          {
            role: "primary",
            contentType: "application/javascript; charset=utf-8",
            encoding: "utf8",
            platform: "android",
          }
        ),
      ],
    };
    buildSystem.getStoredBuild.mockResolvedValueOnce(rnBuild as never);

    await host.reconcileDeclared([
      {
        source: graphNode.relativePath,
        ref: "main",
      },
    ]);
    await host.whenSettled();

    expect(host.registry.get(graphNode.name)).toMatchObject({
      status: "available",
      activeBundleKey: "rn-android-only-key",
      lastError: null,
    });
  });

  it("fails closed when a trusted app manifest drifts to native fields", async () => {
    const { host, buildSystem, eventService, approvalQueue } = await makeHarness({
      invalidManifest: true,
    });

    await host.reconcileDeclared([{ source: "apps/shell", ref: "main" }]);
    await host.whenSettled();

    expect(approvalQueue.request).not.toHaveBeenCalled();
    expect(buildSystem.getStoredBuild).not.toHaveBeenCalled();
    expect(host.registry.get("@workspace-apps/shell")).toMatchObject({
      status: "error",
      activeBundleKey: null,
      lastError: expect.stringContaining("pure-thin"),
    });
    expect(eventService.emit).toHaveBeenCalledWith(
      "supervision:changed",
      expect.objectContaining({
        identity: { kind: "app", entityId: "@workspace-apps/shell" },
        status: "error",
        lastError: expect.stringContaining("pure-thin"),
      })
    );
  });
  it("recovers a persisted building row by owning its approved preparation", async () => {
    const first = await makeHarness();
    first.host.setDeclared([{ source: "apps/shell", ref: "main" }]);
    const review = await first.host.reviewDeclared();
    first.host.acceptPreapprovedTrust(review.identityKeys);
    installApp(first.host, first.graphNode);
    first.host.registry.patch(first.graphNode.name, {
      status: "building",
      activeBundleKey: null,
      activeExecutionDigest: null,
      activeEv: null,
    });
    await first.host.shutdown();

    const restored = await makeHarness({ root: first.root });
    restored.host.setDeclared([{ source: "apps/shell", ref: "main" }]);
    expect(restored.host.registry.get(restored.graphNode.name)?.status).toBe("building");
    await expect(restored.host.ensureActivated(restored.graphNode.name)).resolves.toBe("ready");
    expect(restored.buildSystem.getStoredBuild).toHaveBeenCalledTimes(1);
    expect(restored.approvalQueue.request).not.toHaveBeenCalled();
    expect(restored.host.registry.get(restored.graphNode.name)).toMatchObject({
      status: "running",
      activeBundleKey: "app-key",
    });
    await restored.host.shutdown();
  });

  it("restores an existing immutable release without source authority resolution or rebuilding", async () => {
    const { host, graphNode, buildSystem, approvalQueue } = await makeHarness();
    installApp(host, graphNode);
    host.setDeclared([{ source: "apps/shell", ref: "main" }]);
    host.registry.patch(graphNode.name, { status: "building" });
    await expect(host.ensureActivated(graphNode.name)).resolves.toBe("ready");
    expect(buildSystem.getStoredBuild).not.toHaveBeenCalled();
    expect(buildSystem.resolveBuildUnitIdentity).not.toHaveBeenCalled();
    expect(approvalQueue.request).not.toHaveBeenCalled();
    await host.shutdown();
  });

  it("prepares a demanded host target (admitting its host-build app) before activating it", async () => {
    // The shell is hostTargets.electron.app in the harness; a client can demand
    // it before startup reconciliation has admitted the host build's units.
    const order: string[] = [];
    const prepareHostTarget = vi.fn(async (target: string) => {
      order.push(`prepare:${target}`);
    });
    const { host, graphNode } = await makeHarness({ prepareHostTarget });
    installApp(host, graphNode);
    host.setDeclared([{ source: "apps/shell", ref: "main" }]);
    host.registry.patch(graphNode.name, { status: "building" });
    const activateRelease = vi.spyOn(host, "activateRelease").mockImplementation(async () => {
      order.push("activate");
    });
    await expect(host.ensureActivated(graphNode.name)).resolves.toBe("ready");
    expect(prepareHostTarget).toHaveBeenCalledWith("electron");
    expect(order).toEqual(["prepare:electron", "activate"]);
    activateRelease.mockRestore();
    await host.shutdown();
  });

  it("coalesces activation callers and joins their owned build on shutdown", async () => {
    const { host, graphNode, buildSystem } = await makeHarness();
    host.setDeclared([{ source: "apps/shell", ref: "main" }]);
    host.acceptPreapprovedTrust((await host.reviewDeclared()).identityKeys);
    const built = await buildSystem.getStoredBuild(graphNode.name, "main");
    buildSystem.getStoredBuild.mockClear();
    let finish!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    buildSystem.getStoredBuild.mockImplementation(async () => {
      started();
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return built;
    });
    const a = host.ensureActivated(graphNode.name);
    const b = host.ensureActivated(graphNode.name);
    expect(a).toBe(b);
    await startedPromise;
    let stopped = false;
    const shutdown = host.shutdown().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    await expect(host.ensureActivated(graphNode.name)).rejects.toThrow("retiring");
    finish();
    await expect(a).resolves.toBe("ready");
    await shutdown;
    expect(buildSystem.getStoredBuild).toHaveBeenCalledTimes(1);
  });

  it("propagates the original preparation failure to every activation caller", async () => {
    const { host, graphNode, buildSystem } = await makeHarness();
    host.setDeclared([{ source: "apps/shell", ref: "main" }]);
    host.acceptPreapprovedTrust((await host.reviewDeclared()).identityKeys);
    const failure = new Error("disk could not read the app source");
    buildSystem.getStoredBuild.mockRejectedValue(failure);
    const a = host.ensureActivated(graphNode.name);
    const b = host.ensureActivated(graphNode.name);
    await expect(a).rejects.toBe(failure);
    await expect(b).rejects.toBe(failure);
    expect(host.registry.get(graphNode.name)).toMatchObject({
      status: "error",
      lastError: failure.message,
    });
    await host.shutdown();
  });

  it("opens the review of an unreviewed app and runs it once the review is accepted", async () => {
    const admitted = new Set<string>();
    const { host, graphNode, approvalQueue } = await makeHarness({
      isAdmitted: (_repo, ev) => admitted.has(ev),
    });
    approvalQueue.request.mockImplementationOnce(async () => {
      admitted.add("ev-app");
      return "accepted";
    });
    host.setDeclared([{ source: "apps/shell", ref: "main" }]);

    // Opening asks; it neither fails nor runs unreviewed code.
    await expect(host.ensureActivated(graphNode.name)).resolves.toBe("approval-required");
    expect(approvalQueue.request).toHaveBeenCalledTimes(1);

    // The review's resolution applied the accepted build, so opening again runs it.
    await host.whenSettled();
    await expect(host.ensureActivated(graphNode.name)).resolves.toBe("ready");
    expect(approvalQueue.request).toHaveBeenCalledTimes(1);
    expect(host.registry.get(graphNode.name)?.status).toBe("running");
    await host.shutdown();
  });

  it("does not run a declined app and offers its review again only when it is opened again", async () => {
    const { host, graphNode, approvalQueue, buildSystem } = await makeHarness({
      isAdmitted: () => false,
      approvalDecision: "deny",
    });
    host.setDeclared([{ source: "apps/shell", ref: "main" }]);

    await expect(host.ensureActivated(graphNode.name)).resolves.toBe("approval-required");
    await host.whenSettled();
    expect(approvalQueue.request).toHaveBeenCalledTimes(1);
    expect(buildSystem.getStoredBuild).not.toHaveBeenCalled();
    expect(host.registry.get(graphNode.name)?.status).not.toBe("running");

    await expect(host.ensureActivated(graphNode.name)).resolves.toBe("approval-required");
    expect(approvalQueue.request).toHaveBeenCalledTimes(2);
    await host.shutdown();
  });
});

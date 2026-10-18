import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ledgerTest } from "../../../tests/helpers/ledgerTest.js";

import {
  buildHostBuildUnitInventory,
  hostBuildUnitInventoryPath,
} from "@vibestudio/shared/hostBuildUnits";
import { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import { ConnectionGrantService } from "@vibestudio/shared/connectionGrants";
import type { PendingApproval } from "@vibestudio/shared/approvals";
import type { ProtectedPublicationEvent } from "@vibestudio/shared/protectedPublicationEvents";
import { WORKSPACE_SYSTEM_EPOCH } from "@vibestudio/shared/vcs/systemEpoch";
import type {
  ClientCapability,
  ClientManifestBlock,
  ClientRuntime,
  HostDescriptor,
  HostKind,
} from "@vibestudio/workspace-contracts/clients";
import { ClientHost, type ClientHostDeps, type RuntimePreparation } from "./clientRegistry.js";
import { RuntimeDiagnosticsStore } from "../runtimeDiagnosticsStore.js";
import { UnitInstallReviewCoordinator } from "../unitInstallReviewCoordinator.js";
import type { BuildArtifactManifestEntry, BuildMetadata } from "../buildV2/buildStore.js";

const roots: string[] = [];
const ownedHosts = new Set<ClientHost>();
const originalDevStatus = process.env["VIBESTUDIO_CLIENT_DEV_STATUS"];

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
    contentRoots: [{ repoPath: "clients/desktop-browser", stateHash: `state:${"e".repeat(64)}` }],
    sourceClosureDigest: "f".repeat(64) as never,
  },
  recipeDigest: "c".repeat(64) as never,
  buildKey: "c".repeat(64) as never,
  artifactDigest: "d".repeat(64) as never,
  executionDigest: "a".repeat(64) as never,
};
const DIGEST = TEST_EXECUTION_IDENTITY.executionDigest;

const WEB_SOURCE = "clients/desktop-browser";
const WEB_NAME = "@workspace-clients/desktop-browser";

const CLIENT_DEFAULTS: Record<HostKind, string> = {
  desktop: "clients/desktop-browser",
  terminal: "clients/terminal-browser",
  android: "clients/mobile-browser",
  ios: "clients/mobile-browser",
};

type ClientNode = ReturnType<typeof createClientNode>;
type Build = Awaited<ReturnType<ClientHostDeps["buildSystem"]["getStoredBuild"]>>;

const ABI: Record<ClientRuntime, string> = {
  web: "web-host-1",
  "react-native": "rn-host-6",
  terminal: "terminal-host-1",
};

function publicationEvent(): ProtectedPublicationEvent {
  return {
    publicationId: "publication:test",
    resultHostRefsBasisDigest: "host-refs:test",
    appliedAt: 42,
    workspaceStateHash: "state:published",
    changedPaths: [`${WEB_SOURCE}/index.tsx`],
    repositories: [
      {
        repoPath: WEB_SOURCE,
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
  if (originalDevStatus === undefined) delete process.env["VIBESTUDIO_CLIENT_DEV_STATUS"];
  else process.env["VIBESTUDIO_CLIENT_DEV_STATUS"] = originalDevStatus;
  const failures = retirement.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : []
  );
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, "ClientHost fixture retirement failed");
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-client-host-"));
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

function manifestFor(
  name: string,
  block: ClientManifestBlock,
  extra: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    name,
    version: "1.0.0",
    vibestudio: {
      displayName: block.title ?? name,
      icon: "🖥️",
      client: block,
      authority: { requests: [], provides: [] },
      ...extra,
    },
  };
}

/** A client unit on disk and in the build graph. */
function createClientNode(
  workspacePath: string,
  source: string,
  opts: {
    name: string;
    block: ClientManifestBlock;
    manifest?: Record<string, unknown>;
  }
) {
  const nodePath = path.join(workspacePath, source);
  fs.mkdirSync(nodePath, { recursive: true });
  const packageManifest = opts.manifest ?? manifestFor(opts.name, opts.block);
  fs.writeFileSync(path.join(nodePath, "package.json"), JSON.stringify(packageManifest));
  fs.writeFileSync(path.join(nodePath, opts.block.entry), "export default null;\n");
  return {
    name: opts.name,
    kind: "client" as const,
    relativePath: source,
    path: nodePath,
    packageVersion: packageManifest["version"] as string,
    internalDeps: [] as string[],
    // The graph node carries the manifest it was discovered from; the registry
    // validates it rather than reading the (unmirrored) source directory.
    manifest: {
      displayName: opts.block.title ?? opts.name,
      icon: "🖥️",
      client: opts.block,
      ...((packageManifest["vibestudio"] as Record<string, unknown> | undefined) ?? {}),
    },
  };
}

function webBlock(overrides: Partial<ClientManifestBlock> = {}): ClientManifestBlock {
  return {
    id: "browser",
    runtime: "web",
    hostAbi: ABI.web,
    entry: "index.tsx",
    title: "Vibestudio",
    capabilities: { required: [], optional: ["notifications"] },
    ...overrides,
  };
}

function terminalBlock(overrides: Partial<ClientManifestBlock> = {}): ClientManifestBlock {
  return {
    id: "browser",
    runtime: "terminal",
    hostAbi: ABI.terminal,
    entry: "index.ts",
    title: "Terminal browser",
    capabilities: { optional: ["clipboard"] },
    ...overrides,
  };
}

function reactNativeBlock(overrides: Partial<ClientManifestBlock> = {}): ClientManifestBlock {
  return {
    id: "browser",
    runtime: "react-native",
    hostAbi: ABI["react-native"],
    entry: "index.tsx",
    title: "Mobile browser",
    capabilities: { optional: ["notifications"] },
    ...overrides,
  };
}

/** A sealed build of a client, as the build system stores it. */
function clientBuild(
  root: string,
  input: {
    key: string;
    ev: string;
    runtime?: ClientRuntime;
    clientId?: string;
    hostAbi?: string;
    digest?: string;
    provider?: typeof REACT_NATIVE_PROVIDER | null;
    artifacts?: Array<{
      path: string;
      body: string;
      role: string;
      platform?: "android" | "ios";
      contentType?: string;
    }>;
    authority?: NonNullable<BuildMetadata["authority"]>;
  }
): Build {
  const runtime = input.runtime ?? "web";
  const dir = path.join(root, "state", "builds", input.key);
  const defaults: Record<ClientRuntime, NonNullable<typeof input.artifacts>> = {
    web: [{ path: "index.html", body: `<!doctype html><div>${input.key}</div>`, role: "primary" }],
    terminal: [{ path: "index.mjs", body: "export {};\n", role: "primary" }],
    "react-native": [
      { path: "index.ios.bundle", body: `bundle:${input.key}`, role: "primary", platform: "ios" },
    ],
  };
  const contentType = (artifactPath: string) =>
    artifactPath.endsWith(".html")
      ? "text/html; charset=utf-8"
      : "application/javascript; charset=utf-8";
  const artifacts = (input.artifacts ?? defaults[runtime]).map((artifact) =>
    storedArtifact(dir, artifact.path, artifact.body, {
      role: artifact.role as BuildArtifactManifestEntry["role"],
      contentType: artifact.contentType ?? contentType(artifact.path),
      encoding: "utf8",
      ...(artifact.platform ? { platform: artifact.platform } : {}),
    })
  );
  const provider =
    input.provider === undefined
      ? runtime === "react-native"
        ? REACT_NATIVE_PROVIDER
        : null
      : input.provider;
  return {
    dir,
    buildKey: input.key,
    sourceStateHash: `state:${input.ev}`,
    metadata: {
      kind: "client",
      name: WEB_NAME,
      buildKey: input.key,
      sourcePath: null,
      ev: input.ev,
      sourceStateHash: `state:${input.ev}`,
      sourcemap: false,
      builtAt: "2026-10-12T00:00:00.000Z",
      details: {
        kind: "client",
        clientId: input.clientId ?? "browser",
        runtime,
        hostAbi: input.hostAbi ?? ABI[runtime],
        provider,
      },
      execution: { ...TEST_EXECUTION_IDENTITY, executionDigest: (input.digest ?? DIGEST) as never },
      authority: input.authority ?? { requests: [], provides: [] },
    },
    artifacts,
  } as Build;
}

async function makeHarness(
  opts: {
    root?: string;
    isAdmitted?: ClientHostDeps["isAdmitted"];
    prepareAdmission?: ClientHostDeps["prepareAdmission"];
    openUnitReviewFor?: ClientHostDeps["openUnitReviewFor"];
    seeded?: boolean;
    invalidManifest?: boolean;
    approvalDecision?: "accepted" | "deny";
    useApprovalCoordinator?: boolean;
    readWorkspaceFileAtState?: (stateHash: string, filePath: string) => Promise<string | null>;
    affectedBuildUnits?: string[];
    isSystemWorkspace?: () => boolean;
    trusted?: string[];
    prepareRuntime?: ClientHostDeps["prepareRuntime"];
    block?: ClientManifestBlock;
    beforeInitialize?: (
      host: ClientHost,
      getBuildByKey: ClientHostDeps["buildSystem"]["getBuildByKey"]
    ) => void | Promise<void>;
  } = {}
) {
  const root = opts.root ?? tempRoot();
  const workspacePath = path.join(root, "source");
  fs.mkdirSync(path.join(workspacePath, "meta"), { recursive: true });
  const block = opts.block ?? webBlock();
  const graphNode = createClientNode(workspacePath, WEB_SOURCE, {
    name: WEB_NAME,
    block,
    ...(opts.invalidManifest
      ? {
          manifest: manifestFor(WEB_NAME, {
            ...block,
            preload: "preload.ts",
          } as ClientManifestBlock),
        }
      : {}),
  });
  const appPath = graphNode.path;
  if (opts.seeded) {
    // The host records what a designated template shipped, in host state. Only
    // the web client is recorded here, matching the one unit this harness lays
    // down as shipped source.
    const inventoryPath = hostBuildUnitInventoryPath(path.join(root, "state"));
    fs.mkdirSync(path.dirname(inventoryPath), { recursive: true });
    fs.writeFileSync(
      inventoryPath,
      JSON.stringify(
        buildHostBuildUnitInventory({
          root: workspacePath,
          unitRepoPaths: [WEB_SOURCE],
          templateUrl: "git+https://example.test/base.git",
          commit: "a".repeat(40),
        })
      )
    );
  }
  const builds = new Map<string, Build>();
  const defaultBuild = clientBuild(root, {
    key: "client-key",
    ev: "ev-client",
    runtime: block.runtime,
  });
  builds.set("client-key", defaultBuild);
  const providerChangeCallbacks: Array<() => void> = [];
  const buildSystem = {
    getStoredBuild: vi.fn<ClientHostDeps["buildSystem"]["getStoredBuild"]>(
      async () => defaultBuild
    ),
    getBuildByKey: vi.fn<ClientHostDeps["buildSystem"]["getBuildByKey"]>(
      async (key: string) => builds.get(key) ?? null
    ),
    readBuildArtifactBytes: vi.fn<ClientHostDeps["buildSystem"]["readBuildArtifactBytes"]>(
      async (build, entry) => fs.promises.readFile(path.join(build.dir, entry.path))
    ),
    getEffectiveVersion: vi.fn((name: string): string | null =>
      name === WEB_NAME ? "ev-client" : null
    ),
    resolveBuildUnitIdentity: vi.fn(async () => ({
      unitPath: WEB_SOURCE,
      unitName: WEB_NAME,
      stateHash: "state:current",
      manifest: { authority: { requests: [], provides: [] } },
      serviceBindings: [],
      serviceReviews: [],
      effectiveVersion: "ev-client",
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
    onBuildProviderChange: vi.fn((callback: () => void) => {
      providerChangeCallbacks.push(callback);
      return () => {
        const index = providerChangeCallbacks.indexOf(callback);
        if (index >= 0) providerChangeCallbacks.splice(index, 1);
      };
    }),
    getGraph: vi.fn(() => ({ allNodes: () => [graphNode] as ClientNode[] })),
    onPushBuild: vi.fn(),
    onUnitChange: vi.fn(),
  };
  const eventService = { emit: vi.fn(), getOrCreateSubscriber: vi.fn(), subscribe: vi.fn() };
  const approvalQueue = {
    request: vi.fn(async (_req: unknown) => opts.approvalDecision ?? ("accepted" as const)),
    listPending: vi.fn<() => PendingApproval[]>(() => []),
    holdForUnitReview: vi.fn(() => () => {}),
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
  const trusted = opts.trusted ?? [
    WEB_SOURCE,
    "clients/mobile-browser",
    "clients/terminal-browser",
  ];
  const prepareRuntime = vi.fn(opts.prepareRuntime ?? (async () => ({ state: "ready" as const })));
  const revokePrincipalSessions = vi.fn<NonNullable<ClientHostDeps["revokePrincipalSessions"]>>();
  const host = new ClientHost({
    statePath,
    workspacePath,
    workspaceId: "ws",
    diagnostics,
    isSystemWorkspace: opts.isSystemWorkspace ?? (() => true),
    getTrustedClients: () => trusted,
    getClientDefault: (hostKind) => CLIENT_DEFAULTS[hostKind],
    prepareRuntime,
    buildSystem,
    isAdmitted: opts.isAdmitted,
    ...(opts.prepareAdmission ? { prepareAdmission: opts.prepareAdmission } : {}),
    openUnitReviewFor: opts.openUnitReviewFor,
    eventService: eventService as never,
    approvalQueue,
    approvalCoordinator,
    notificationService,
    entityCache,
    revokePrincipalSessions,
    readWorkspaceFileAtState: async (stateHash, filePath) =>
      (await opts.readWorkspaceFileAtState?.(stateHash, filePath)) ??
      (filePath === `${WEB_SOURCE}/package.json`
        ? fs.readFileSync(path.join(appPath, "package.json"), "utf8")
        : null),
  });
  ownedHosts.add(host);
  try {
    await opts.beforeInitialize?.(host, buildSystem.getBuildByKey);
    await host.initialize();
  } catch (error) {
    // Failed fixture creation still owns initialization work. Shutdown joins
    // it before the test is allowed to retire its scratch root.
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
        "ClientHost fixture initialization and retirement failed"
      );
    }
    throw error;
  }
  return {
    host,
    buildSystem,
    builds,
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
    trusted,
    prepareRuntime,
    revokePrincipalSessions,
    providerChangeCallbacks,
    defaultBuild,
  };
}

/** Put the harness client into the registry as an adopted, running release. */
function installClient(
  host: ClientHost,
  node: Pick<ClientNode, "name" | "relativePath"> & { manifest: { client: ClientManifestBlock } },
  opts: {
    runtime?: ClientRuntime;
    activeBundleKey?: string;
    activeExecutionDigest?: string;
    activeEv?: string;
    capabilities?: ClientCapability[];
    status?: "running" | "available";
    ref?: string;
    previousVersions?: Array<{ activeBundleKey: string; activeEv: string | null }>;
  } = {}
): void {
  const runtime = opts.runtime ?? node.manifest.client.runtime;
  const capabilities =
    opts.capabilities ??
    ([
      ...(node.manifest.client.capabilities?.required ?? []),
      ...(node.manifest.client.capabilities?.optional ?? []),
    ].sort() as ClientCapability[]);
  host.registry.upsert({
    unitKind: "client",
    name: node.name,
    version: "1.0.0",
    runtime,
    capabilities,
    source: { kind: "workspace-repo", repo: node.relativePath, ref: opts.ref ?? "main" },
    installedAt: Date.now(),
    activeEv: opts.activeEv ?? "ev-client",
    activeSourceHash: "abc123",
    activeBundleKey: opts.activeBundleKey ?? "client-key",
    activeExecutionDigest: opts.activeExecutionDigest ?? DIGEST,
    activeDependencyEvs: {},
    activeExternalDeps: {},
    activeRuntimeDepsKey: null,
    status: opts.status ?? "running",
    lastError: null,
    previousVersions: (opts.previousVersions ?? []).map((version) => ({
      version: "1.0.0",
      runtime,
      capabilities,
      activeEv: version.activeEv,
      activeSourceHash: "previous-sha",
      activeBundleKey: version.activeBundleKey,
      executionDigest: DIGEST,
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

/** Declare the harness client and record the person's acceptance of its exact version. */
async function declareTrusted(host: ClientHost): Promise<void> {
  host.setDeclared([{ source: WEB_SOURCE, ref: "main" }]);
  host.acceptPreapprovedTrust((await host.reviewDeclared()).identityKeys);
}

function desktopHost(overrides: Partial<HostDescriptor> = {}): HostDescriptor {
  return {
    host: "desktop",
    hostVersion: "1.0.0",
    runtimes: { web: ABI.web },
    capabilities: ["device-session", "panel-hosting", "approval-surface", "notifications"],
    ...overrides,
  };
}

function terminalHost(overrides: Partial<HostDescriptor> = {}): HostDescriptor {
  return {
    host: "terminal",
    hostVersion: "1.0.0",
    runtimes: { terminal: ABI.terminal },
    capabilities: ["device-session", "approval-surface", "clipboard"],
    ...overrides,
  };
}

function workspaceYaml(config: { clients: string[]; trust?: string[] }): string {
  return [
    `systemEpoch: ${WORKSPACE_SYSTEM_EPOCH}`,
    ...(config.clients.length > 0
      ? ["clients:", ...config.clients.map((source) => `  - source: ${source}`)]
      : ["clients: []"]),
    ...(config.trust
      ? config.trust.length > 0
        ? ["trust:", "  clients:", ...config.trust.map((source) => `    - ${source}`)]
        : ["trust:", "  clients: []"]
      : []),
    "",
  ].join("\n");
}

describe("ClientHost lifecycle", () => {
  it("requires initialization before synchronous version reads and reuses one initialization flight", async () => {
    await makeHarness({
      beforeInitialize: async (host) => {
        expect(() => host.listClientVersions(WEB_SOURCE)).toThrow("must be initialized");
        const initialization = host.initialize();
        expect(host.initialize()).toBe(initialization);
        await initialization;
        expect(host.listClientVersions(WEB_SOURCE)).toMatchObject({ current: null, previous: [] });
      },
    });
  });

  it("backfills and persists legacy active and retained execution identities before admission", async () => {
    const first = await makeHarness();
    installClient(first.host, first.graphNode);
    const current = first.host.listClientVersions(first.graphNode.name).current!;
    const { executionDigest: _legacyMissingDigest, ...legacyVersion } = current;
    first.host.registry.patch(first.graphNode.name, {
      activeExecutionDigest: null,
      previousVersions: [legacyVersion] as never,
    });
    await first.host.shutdown();

    const restored = await makeHarness({ root: first.root });
    expect(restored.host.listClientVersions(restored.graphNode.name)).toMatchObject({
      current: { executionDigest: DIGEST },
      previous: [{ executionDigest: DIGEST }],
    });
    expect(restored.buildSystem.getBuildByKey).toHaveBeenCalledWith("client-key");
    expect(restored.buildSystem.getStoredBuild).not.toHaveBeenCalled();
    await restored.host.shutdown();
    const persisted = await makeHarness({ root: first.root });
    expect(persisted.buildSystem.getBuildByKey).not.toHaveBeenCalled();
    await persisted.host.shutdown();
  });

  it("fails closed when a legacy active execution references an unavailable immutable build", async () => {
    const first = await makeHarness();
    installClient(first.host, first.graphNode);
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
    installClient(first.host, first.graphNode);
    const current = first.host.listClientVersions(first.graphNode.name).current!;
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

  it("serves only active builds and builds retained for rollback", async () => {
    const { host, graphNode } = await makeHarness();
    installClient(host, graphNode, {
      previousVersions: [{ activeBundleKey: "client-key-old", activeEv: "ev-old" }],
    });

    await expect(host.servesBuild("client-key")).resolves.toBe(true);
    await expect(host.servesBuild("client-key-old")).resolves.toBe(true);
    await expect(host.servesBuild("unrelated-key")).resolves.toBe(false);
  });

  it("emits a development status diagnostic", async () => {
    process.env["VIBESTUDIO_CLIENT_DEV_STATUS"] = "1";
    const consoleInfo = vi.spyOn(console, "info").mockImplementation(() => {});
    const { host } = await makeHarness();

    try {
      await host.reconcileDeclared([{ source: WEB_SOURCE, ref: "main" }]);
      await host.whenSettled();

      expect(consoleInfo).toHaveBeenCalledWith(expect.stringContaining(WEB_NAME));
      expect(consoleInfo).toHaveBeenCalledWith(expect.stringContaining("runtime=web"));
      expect(consoleInfo).toHaveBeenCalledWith(expect.stringContaining("ev=ev-client"));
      expect(consoleInfo).toHaveBeenCalledWith(expect.stringContaining("build=client-key"));
      expect(consoleInfo).toHaveBeenCalledWith(expect.stringContaining("ref=main"));
    } finally {
      consoleInfo.mockRestore();
    }
  });
});

describe("ClientHost declarations and review", () => {
  it("reviews resolved service authority from the exact client source", async () => {
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

  it("carries the runtime and declared capabilities on the reviewed client", async () => {
    const { host, graphNode } = await makeHarness({
      block: webBlock({
        capabilities: { required: ["panel-hosting"], optional: ["notifications"] },
      }),
    });
    const review = await host.reviewDeclared([{ source: graphNode.relativePath, ref: "main" }]);
    expect(review.units).toEqual([
      expect.objectContaining({
        unitKind: "client",
        unitName: WEB_NAME,
        runtime: "web",
        capabilities: ["notifications", "panel-hosting"],
        icon: "🖥️",
      }),
    ]);
  });

  it("keeps client source authorable outside System without staging launch reviews or runtimes", async () => {
    const { host, buildSystem, approvalQueue, graphNode, workspacePath } = await makeHarness({
      isSystemWorkspace: () => false,
      seeded: true,
    });
    const mobile = createClientNode(workspacePath, "clients/mobile-browser", {
      name: "@workspace-clients/mobile-browser",
      block: reactNativeBlock(),
    });
    const terminal = createClientNode(workspacePath, "clients/terminal-browser", {
      name: "@workspace-clients/terminal-browser",
      block: terminalBlock(),
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
    expect(await host.trustDeltaForCommit(`state:${"a".repeat(64)}`)).toEqual([]);
    expect(await host.listClients(desktopHost())).toEqual([]);
    await expect(host.launch({ host: desktopHost(), select: { default: true } })).resolves.toEqual({
      state: "unavailable",
      reason: "Clients run only from the System workspace",
    });
    expect(approvalQueue.request).not.toHaveBeenCalled();
    expect(buildSystem.getStoredBuild).not.toHaveBeenCalled();
    expect(host.registry.list()).toEqual([]);
    expect(buildSystem.getGraph().allNodes()).toEqual(nodes);
  });

  it("computes meta-change approvals from committed workspace config", async () => {
    const readWorkspaceFileAtState = vi.fn(async (_stateHash: string, filePath: string) =>
      filePath === "meta/vibestudio.yml" ? workspaceYaml({ clients: [WEB_SOURCE] }) : null
    );
    const { host } = await makeHarness({ readWorkspaceFileAtState });

    const approval = await host.unitChangeApprovalForCommit("state:next");

    expect(readWorkspaceFileAtState).toHaveBeenCalledWith("state:next", "meta/vibestudio.yml");
    expect(approval.units).toEqual([
      expect.objectContaining({
        unitKind: "client",
        unitName: WEB_NAME,
        runtime: "web",
        source: { kind: "workspace-repo", repo: WEB_SOURCE, ref: "main" },
      }),
    ]);
  });

  it("does not review clients for an unrelated repository publication", async () => {
    const readWorkspaceFileAtState = vi.fn(async (_stateHash: string, filePath: string) =>
      filePath === "meta/vibestudio.yml" ? workspaceYaml({ clients: [WEB_SOURCE] }) : null
    );
    const { host } = await makeHarness({ readWorkspaceFileAtState, affectedBuildUnits: [] });
    host.setDeclared([{ source: WEB_SOURCE, ref: "main" }]);

    const approval = await host.unitChangeApprovalForCommit("state:next", {
      changedPaths: ["workers/notes/index.ts"],
    });

    expect(approval).toMatchObject({ units: [], identityKeys: [], unchangedCount: 0 });
  });

  it("admits code-only client changes without restaging unchanged service authority", async () => {
    const { host, appPath, buildSystem } = await makeHarness({
      readWorkspaceFileAtState: async (_state, filePath) =>
        filePath === "meta/vibestudio.yml" ? workspaceYaml({ clients: [WEB_SOURCE] }) : null,
    });
    const packagePath = path.join(appPath, "package.json");
    const manifest = JSON.parse(fs.readFileSync(packagePath, "utf8"));
    manifest.vibestudio.authority.serviceRequests = [
      { protocol: "example.tasks.v1", availability: "required" },
    ];
    fs.writeFileSync(packagePath, JSON.stringify(manifest));
    host.setDeclared([{ source: WEB_SOURCE, ref: "main" }]);
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

  it("reviews a changed service contract even when the client manifest is unchanged", async () => {
    const { host, buildSystem } = await makeHarness({
      readWorkspaceFileAtState: async (_state, filePath) =>
        filePath === "meta/vibestudio.yml" ? workspaceYaml({ clients: [WEB_SOURCE] }) : null,
    });
    host.setDeclared([{ source: WEB_SOURCE, ref: "main" }]);
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

  it("admits the exact clients an accepted publication lands, with their activation trust", async () => {
    const admitted: Array<{ ev: string | null | undefined; origin: string }> = [];
    const outcomes: string[] = [];
    const { host, buildSystem } = await makeHarness({
      readWorkspaceFileAtState: async (_state, filePath) =>
        filePath === "meta/vibestudio.yml" ? workspaceYaml({ clients: [WEB_SOURCE] }) : null,
      prepareAdmission: (units, origin) => {
        for (const unit of units) admitted.push({ ev: unit.ev, origin });
        return {
          committed: () => outcomes.push("committed"),
          failed: () => outcomes.push("failed"),
        };
      },
    });
    host.setDeclared([{ source: WEB_SOURCE, ref: "main" }]);
    const current = await buildSystem.resolveBuildUnitIdentity();
    buildSystem.resolveBuildUnitIdentity.mockResolvedValueOnce({
      ...current,
      effectiveVersion: "ev-next",
    });
    // An update that changes no declared authority earns no review row, and is
    // still admitted: the version must run once the publication lands.
    const approval = await host.unitChangeApprovalForCommit("state:next");
    expect(approval.units).toEqual([]);

    const transaction = host.preparePreapprovedTrust(approval.identityKeys);
    expect(admitted).toEqual([{ ev: "ev-next", origin: "publication" }]);
    transaction.committed();
    expect(outcomes).toEqual(["committed"]);

    host.preparePreapprovedTrust(approval.identityKeys).failed(new Error("ref write failed"));
    expect(outcomes).toEqual(["committed", "failed"]);
  });

  it("treats an omitted capability declaration as empty", async () => {
    const { host, appPath } = await makeHarness({
      readWorkspaceFileAtState: async (_state, filePath) =>
        filePath === "meta/vibestudio.yml" ? workspaceYaml({ clients: [WEB_SOURCE] }) : null,
    });
    const { capabilities: _omitted, ...block } = webBlock();
    fs.writeFileSync(
      path.join(appPath, "package.json"),
      JSON.stringify(manifestFor(WEB_NAME, block))
    );

    const approval = await host.unitChangeApprovalForCommit("state:next");

    expect(approval.units).toEqual([
      expect.objectContaining({ unitKind: "client", unitName: WEB_NAME, capabilities: [] }),
    ]);
  });

  it("takes a unit the designated template shipped as a host-build unit", async () => {
    // Skipping the workspace admission review is what lets the shell render a
    // review at all; without it the shell waits on a decision only it can show.
    const { host } = await makeHarness({ seeded: true });
    const declared = [{ source: WEB_SOURCE, ref: "main" }];

    expect((await host.seedTrustedDeclared(declared)).map((unit) => unit.source.repo)).toEqual([
      WEB_SOURCE,
    ]);
  });

  it("stops taking it as a host-build unit once its source is edited", async () => {
    const { host, workspacePath } = await makeHarness({ seeded: true });
    const declared = [{ source: WEB_SOURCE, ref: "main" }];

    fs.writeFileSync(path.join(workspacePath, WEB_SOURCE, "index.tsx"), "export default 1;\n");

    expect(await host.seedTrustedDeclared(declared)).toEqual([]);
  });

  it("still prompts for exact product-seeded client source", async () => {
    const { host, buildSystem, eventService, approvalQueue } = await makeHarness({ seeded: true });

    await host.reconcileDeclared([{ source: WEB_SOURCE, ref: "main" }]);
    await host.whenSettled();

    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "unit-install-review",
        mode: "adopt-root",
        units: [
          expect.objectContaining({
            unitKind: "client",
            unitName: WEB_NAME,
            source: { kind: "workspace-repo", repo: WEB_SOURCE, ref: "main" },
          }),
        ],
      })
    );
    expect(buildSystem.getStoredBuild).toHaveBeenCalledWith(WEB_NAME, "main");
    expect(host.registry.get(WEB_NAME)).toMatchObject({
      unitKind: "client",
      activeBundleKey: "client-key",
      status: "available",
    });
    expect(eventService.emit).not.toHaveBeenCalledWith(
      "supervision:changed",
      expect.objectContaining({ change: "adopted" })
    );
  });

  it("takes a declared client's version and manifest from the graph, not the source directory", async () => {
    // The source directory does not mirror main: a client published after the
    // workspace was provisioned has no files there.
    const { host, appPath } = await makeHarness({ seeded: true });
    fs.rmSync(appPath, { recursive: true, force: true });

    await host.reconcileDeclared([{ source: WEB_SOURCE, ref: "main" }]);
    await host.whenSettled();

    expect(host.registry.get(WEB_NAME)).toMatchObject({ version: "1.0.0" });
    expect(host.registry.get(WEB_NAME)?.lastError ?? null).toBeNull();
  });

  it("fails closed when a trusted client manifest drifts to native fields", async () => {
    const { host, buildSystem, eventService, approvalQueue } = await makeHarness({
      invalidManifest: true,
    });

    await host.reconcileDeclared([{ source: WEB_SOURCE, ref: "main" }]);
    await host.whenSettled();

    expect(approvalQueue.request).not.toHaveBeenCalled();
    expect(buildSystem.getStoredBuild).not.toHaveBeenCalled();
    expect(host.registry.get(WEB_NAME)).toMatchObject({
      status: "error",
      activeBundleKey: null,
      lastError: expect.stringContaining('unknown field "preload"'),
    });
    expect(eventService.emit).toHaveBeenCalledWith(
      "supervision:changed",
      expect.objectContaining({
        identity: { kind: "client", entityId: WEB_NAME },
        status: "error",
        lastError: expect.stringContaining('unknown field "preload"'),
      })
    );
  });

  it("publishes pending startup approvals through the shared coordinator", async () => {
    const { host, graphNode, approvalQueue, approvalCoordinator } = await makeHarness({
      useApprovalCoordinator: true,
    });

    await host.reconcileDeclared([{ source: WEB_SOURCE, ref: "main" }]);

    expect(host.registry.get(graphNode.name)).toMatchObject({ status: "pending-approval" });
    expect(approvalQueue.request).not.toHaveBeenCalled();

    approvalCoordinator?.publishPending("startup");

    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "unit-install-review",
        mode: "adopt-root",
        units: [
          expect.objectContaining({ unitKind: "client", unitName: WEB_NAME, runtime: "web" }),
        ],
      })
    );
  });
});

describe("ClientHost releases", () => {
  it("builds and registers a release without activating it", async () => {
    const { host, buildSystem, eventService } = await makeHarness();

    await host.reconcileDeclared([{ source: WEB_SOURCE, ref: "main" }]);
    await host.whenSettled();

    expect(buildSystem.getStoredBuild).toHaveBeenCalledWith(WEB_NAME, "main");
    expect(host.registry.get(WEB_NAME)).toMatchObject({
      unitKind: "client",
      runtime: "web",
      capabilities: ["notifications"],
      activeBundleKey: "client-key",
      activeSourceHash: "state:ev-client",
      status: "available",
    });
    expect(eventService.emit).not.toHaveBeenCalledWith(
      "supervision:changed",
      expect.objectContaining({ change: "adopted" })
    );
  });

  it("keeps an existing approved release prepared after restart", async () => {
    const { host, buildSystem, graphNode } = await makeHarness();
    installClient(host, graphNode);

    await host.reconcileDeclared([{ source: WEB_SOURCE, ref: "main" }]);
    await host.whenSettled();

    expect(buildSystem.getStoredBuild).not.toHaveBeenCalled();
  });

  it("surfaces push rebuild failures and keeps the previous build active", async () => {
    const { host, buildSystem, eventService, notificationService, diagnostics, graphNode } =
      await makeHarness();
    installClient(host, graphNode);
    buildSystem.getStoredBuild.mockRejectedValueOnce(new Error("broken client code"));

    const onPush = buildSystem.onPushBuild.mock.calls[0]?.[0] as
      | ((source: string) => void)
      | undefined;
    expect(onPush).toBeDefined();
    onPush?.(WEB_SOURCE);
    await flushAsyncWork();

    expect(host.registry.get(WEB_NAME)).toMatchObject({
      status: "running",
      lastError: "broken client code",
      lastErrorDetails: expect.objectContaining({
        phase: "build",
        runtime: "web",
        source: WEB_SOURCE,
      }),
      activeBundleKey: "client-key",
      activeEv: "ev-client",
    });
    expect(eventService.emit).toHaveBeenCalledWith(
      "supervision:changed",
      expect.objectContaining({
        identity: { kind: "client", entityId: WEB_NAME },
        change: "status",
        status: "running",
        lastError: "broken client code",
        artifact: expect.objectContaining({ buildKey: "client-key" }),
        canRollback: false,
        client: expect.objectContaining({ id: "browser", runtime: "web" }),
      })
    );
    expect(diagnostics.history(WEB_NAME).errors[0]).toMatchObject({
      message: "broken client code",
      fields: {
        status: "running",
        errorDetails: { phase: "build", source: WEB_SOURCE },
      },
    });
    expect(eventService.emit).toHaveBeenCalledWith(
      "supervision:changed",
      expect.objectContaining({
        identity: { kind: "client", entityId: WEB_NAME },
        change: "update-rejected",
        status: "running",
        lastError: "broken client code",
      })
    );
    expect(notificationService.show).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", title: "Update not adopted" })
    );
  });

  it("rebuilds an installed client when its main-head effective version changes and announces the new build", async () => {
    const { host, buildSystem, eventService, graphNode, root, builds } = await makeHarness();
    installClient(host, graphNode);
    const changed = clientBuild(root, { key: "client-key-2", ev: "ev-client-2" });
    builds.set("client-key-2", changed);
    buildSystem.getStoredBuild.mockResolvedValueOnce(changed);

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
      name: WEB_NAME,
      relativePath: WEB_SOURCE,
      kind: "client",
      trigger: publicationEvent(),
    });
    await flushAsyncWork();

    expect(buildSystem.getStoredBuild).toHaveBeenCalledWith(WEB_NAME, "main");
    expect(host.registry.get(WEB_NAME)).toMatchObject({
      status: "available",
      activeBundleKey: "client-key-2",
      activeEv: "ev-client-2",
      previousVersions: [
        expect.objectContaining({ activeBundleKey: "client-key", activeEv: "ev-client" }),
      ],
    });
    const adopted = eventService.emit.mock.calls.find(
      ([name, payload]) => name === "supervision:changed" && payload.change === "adopted"
    )?.[1];
    expect(adopted).toMatchObject({
      identity: { kind: "client", entityId: WEB_NAME },
      artifact: expect.objectContaining({ buildKey: "client-key-2" }),
      previousBuildKey: "client-key",
      client: { id: "browser", runtime: "web", grantedCapabilities: ["notifications"] },
    });
    // Hosts decide when to take an update: the server states no adoption policy.
    expect(adopted).not.toHaveProperty("adoption");
  });

  it("records version history, announces rollbacks and rolls back to the previous build", async () => {
    const { host, buildSystem, eventService, graphNode, root, builds } = await makeHarness();
    installClient(host, graphNode);
    const next = clientBuild(root, { key: "client-key-2", ev: "ev-client-2" });
    builds.set("client-key-2", next);
    buildSystem.getStoredBuild.mockResolvedValueOnce(next);

    const onPush = buildSystem.onPushBuild.mock.calls[0]?.[0] as
      | ((source: string) => void)
      | undefined;
    onPush?.(WEB_SOURCE);
    await flushAsyncWork();

    expect(host.registry.get(WEB_NAME)).toMatchObject({
      activeBundleKey: "client-key-2",
      previousVersions: [expect.objectContaining({ activeBundleKey: "client-key" })],
    });
    await expect(host.servesBuild("client-key")).resolves.toBe(true);

    await host.rollbackClientVersion(WEB_NAME);

    expect(host.registry.get(WEB_NAME)).toMatchObject({
      status: "running",
      activeBundleKey: "client-key",
      activeEv: "ev-client",
      previousVersions: [
        expect.objectContaining({ activeBundleKey: "client-key-2", activeEv: "ev-client-2" }),
      ],
    });
    expect(eventService.emit).toHaveBeenCalledWith(
      "supervision:changed",
      expect.objectContaining({
        change: "rolled-back",
        identity: { kind: "client", entityId: WEB_NAME },
        artifact: expect.objectContaining({ buildKey: "client-key" }),
        canRollback: true,
        client: expect.objectContaining({ id: "browser" }),
      })
    );
    await expect(host.rollbackClientVersion(WEB_NAME, "missing")).rejects.toThrow(
      "No rollback version missing is available"
    );
  });

  it("refuses to roll back to a retained build that no longer satisfies the contract", async () => {
    const { host, graphNode, builds, root } = await makeHarness();
    installClient(host, graphNode, {
      previousVersions: [{ activeBundleKey: "client-key-old", activeEv: "ev-old" }],
    });
    builds.set(
      "client-key-old",
      clientBuild(root, {
        key: "client-key-old",
        ev: "ev-old",
        artifacts: [{ path: "index.js", body: "x", role: "primary" }],
      })
    );
    await expect(host.rollbackClientVersion(WEB_NAME, "client-key-old")).rejects.toThrow(
      "must include exactly one primary HTML page"
    );
    expect(host.registry.get(WEB_NAME)?.activeBundleKey).toBe("client-key");
  });

  it("activates an exact prepared release and announces its sealed authority", async () => {
    const { host, builds, root, eventService, graphNode } = await makeHarness();
    installClient(host, graphNode, { status: "available" });
    const authority = {
      provides: [],
      requests: [
        {
          capability: "service:events.watch",
          resource: { kind: "exact" as const, key: "service:events.watch" },
          tier: "gated" as const,
          evidence: "exact" as const,
        },
      ],
    };
    builds.set("client-key", clientBuild(root, { key: "client-key", ev: "ev-client", authority }));

    await expect(host.activateRelease(WEB_NAME)).resolves.toBeUndefined();
    expect(eventService.emit).toHaveBeenCalledWith(
      "supervision:changed",
      expect.objectContaining({
        identity: { kind: "client", entityId: WEB_NAME },
        source: WEB_SOURCE,
        change: "adopted",
        client: expect.objectContaining({ runtime: "web", authority }),
      })
    );
  });

  it("prepares an unbuilt release before activation", async () => {
    const { host, buildSystem, eventService } = await makeHarness();

    host.setDeclared([{ source: WEB_SOURCE, ref: "main" }]);
    await host.reconcileDeclared([{ source: WEB_SOURCE, ref: "main" }]);
    await host.whenSettled();
    await expect(host.activateRelease(WEB_NAME)).resolves.toBeUndefined();
    expect(buildSystem.getStoredBuild).toHaveBeenCalledWith(WEB_NAME, "main");
    expect(host.registry.get(WEB_NAME)).toMatchObject({
      runtime: "web",
      activeBundleKey: "client-key",
      status: "running",
    });
    expect(eventService.emit).toHaveBeenCalledWith(
      "supervision:changed",
      expect.objectContaining({
        identity: { kind: "client", entityId: WEB_NAME },
        change: "adopted",
        client: expect.objectContaining({ runtime: "web" }),
      })
    );
  });

  it("rebuilds a current client when its active immutable artifact is missing", async () => {
    const { host, buildSystem, builds } = await makeHarness();
    const declared = [{ source: WEB_SOURCE, ref: "main" }];

    await host.reconcileDeclared(declared);
    await host.whenSettled();
    const built = await buildSystem.getStoredBuild.mock.results[0]!.value;
    buildSystem.getStoredBuild.mockClear();

    builds.clear();
    buildSystem.getStoredBuild.mockImplementation(async () => {
      builds.set("client-key", built);
      return built;
    });

    await host.activateRelease(WEB_NAME);

    expect(buildSystem.getStoredBuild).toHaveBeenCalledExactlyOnceWith(WEB_NAME, "main");
    expect(host.registry.get(WEB_NAME)).toMatchObject({
      activeBundleKey: "client-key",
      status: "running",
      lastError: null,
    });
  });

  it("refuses to adopt a build whose contract is violated and keeps the running one", async () => {
    const { host, buildSystem, graphNode, root } = await makeHarness();
    installClient(host, graphNode);
    buildSystem.getStoredBuild.mockResolvedValueOnce(
      clientBuild(root, {
        key: "client-key-bad",
        ev: "ev-bad",
        artifacts: [{ path: "index.html", body: "<!doctype html>", role: "primary" }],
        hostAbi: "web-host-2",
      })
    );
    const onPush = buildSystem.onPushBuild.mock.calls[0]?.[0] as (source: string) => void;
    onPush(WEB_SOURCE);
    await flushAsyncWork();

    expect(host.registry.get(WEB_NAME)).toMatchObject({
      activeBundleKey: "client-key",
      lastError: expect.stringContaining("produced for web-host-2"),
      lastErrorDetails: expect.objectContaining({ phase: "contract", buildKey: "client-key-bad" }),
    });
  });

  ledgerTest("execution.client-web", async () => {
    const { host, buildSystem, root } = await makeHarness({
      block: webBlock({
        capabilities: { required: ["panel-hosting"], optional: ["notifications"] },
      }),
    });
    const pinned = clientBuild(root, { key: "pinned-ref-key", ev: "ev-pinned" });
    buildSystem.getStoredBuild.mockResolvedValueOnce(pinned);

    const result = await host.prepareRelease(WEB_SOURCE, "state:0123456789abcdef");

    expect(result).toEqual({
      buildKey: "pinned-ref-key",
      effectiveVersion: "ev-pinned",
      clientName: WEB_NAME,
      source: WEB_SOURCE,
    });
    const entry = host.registry.get(WEB_NAME);
    expect(entry).toMatchObject({
      activeBundleKey: "pinned-ref-key",
      activeEv: "ev-pinned",
      source: { ref: "state:0123456789abcdef" },
      activationTrust: {
        decision: "release-pinned-ref",
        actor: "host",
        reason: expect.stringContaining("explicit ref"),
      },
    });
    expect(JSON.parse(entry?.activationTrust?.identityKey ?? "{}")).toMatchObject({
      unitKind: "client",
      name: WEB_NAME,
      source: { repo: WEB_SOURCE, ref: "state:0123456789abcdef" },
      effectiveVersion: "ev-pinned",
      capabilities: ["notifications", "panel-hosting"],
    });
  });

  it("keeps an unaccepted build inspectable but prevents promotion and activation", async () => {
    const review = { approvalId: "review-client", title: "Review Client" };
    let openReview = true;
    const { host, buildSystem, eventService, graphNode, root, builds } = await makeHarness({
      isAdmitted: () => false,
      openUnitReviewFor: () => (openReview ? review : null),
    });
    const candidate = clientBuild(root, { key: "client-key-new", ev: "ev-unaccepted" });
    buildSystem.getStoredBuild.mockResolvedValue(candidate);
    builds.set("client-key-new", candidate);

    await expect(
      host.prepareRelease(graphNode.relativePath, "candidate-ref")
    ).resolves.toMatchObject({
      buildKey: "client-key-new",
      effectiveVersion: "ev-unaccepted",
      source: graphNode.relativePath,
    });
    expect(host.registry.get(graphNode.name)?.activeBundleKey).toBeUndefined();

    installClient(host, graphNode, {
      activeBundleKey: "client-key-new",
      activeEv: "ev-unaccepted",
      status: "available",
      ref: "candidate-ref",
    });
    await expect(host.activateRelease(graphNode.name)).rejects.toMatchObject({
      name: "ServiceAccessError",
      service: "runtime.supervision",
      code: "EREVIEWPENDING",
      errorData: {
        authorityFailure: { remediation: { kind: "resolve-open-review", review } },
      },
    });
    expect(host.registry.get(graphNode.name)).toMatchObject({
      activeBundleKey: "client-key-new",
      status: "available",
    });
    expect(eventService.emit).not.toHaveBeenCalledWith(
      "supervision:changed",
      expect.objectContaining({ change: "adopted" })
    );
    await expect(
      host.grantPrincipal("device-1", {
        source: graphNode.relativePath,
        buildKey: "client-key-new",
        executionDigest: DIGEST,
      })
    ).rejects.toMatchObject({ code: "EREVIEWPENDING" });

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
  });

  it("keeps the prior admitted build active when a candidate lacks exact admission", async () => {
    const admitted = new Set(["ev-old"]);
    const { host, buildSystem, graphNode, root, builds } = await makeHarness({
      isAdmitted: (_repo, ev) => admitted.has(ev),
    });
    const oldBuild = clientBuild(root, { key: "client-old", ev: "ev-old" });
    const candidate = clientBuild(root, { key: "client-candidate", ev: "ev-candidate" });
    builds.set("client-old", oldBuild);
    builds.set("client-candidate", candidate);
    buildSystem.getStoredBuild.mockResolvedValue(candidate);
    installClient(host, graphNode, { activeBundleKey: "client-old", activeEv: "ev-old" });
    await host.activateRelease(graphNode.name);

    await host.reconcileDeclared([{ source: graphNode.relativePath, ref: "candidate-ref" }]);
    await host.whenSettled();

    expect(host.registry.get(graphNode.name)).toMatchObject({
      activeBundleKey: "client-old",
      activeEv: "ev-old",
      status: "error",
      lastError: expect.stringContaining("needs your review before it can run"),
    });
  });

  it("recovers a persisted building row by owning its approved preparation", async () => {
    const first = await makeHarness();
    first.host.setDeclared([{ source: WEB_SOURCE, ref: "main" }]);
    const review = await first.host.reviewDeclared();
    first.host.acceptPreapprovedTrust(review.identityKeys);
    installClient(first.host, first.graphNode);
    first.host.registry.patch(first.graphNode.name, {
      status: "building",
      activeBundleKey: null,
      activeExecutionDigest: null,
      activeEv: null,
    });
    await first.host.shutdown();

    const restored = await makeHarness({ root: first.root });
    restored.host.setDeclared([{ source: WEB_SOURCE, ref: "main" }]);
    expect(restored.host.registry.get(restored.graphNode.name)?.status).toBe("building");
    await expect(restored.host.ensureActivated(restored.graphNode.name)).resolves.toBe("ready");
    expect(restored.buildSystem.getStoredBuild).toHaveBeenCalledTimes(1);
    expect(restored.approvalQueue.request).not.toHaveBeenCalled();
    expect(restored.host.registry.get(restored.graphNode.name)).toMatchObject({
      status: "running",
      activeBundleKey: "client-key",
    });
    await restored.host.shutdown();
  });

  it("restores an existing immutable release without source authority resolution or rebuilding", async () => {
    const { host, graphNode, buildSystem, approvalQueue } = await makeHarness();
    installClient(host, graphNode);
    host.setDeclared([{ source: WEB_SOURCE, ref: "main" }]);
    host.registry.patch(graphNode.name, { status: "building" });
    await expect(host.ensureActivated(graphNode.name)).resolves.toBe("ready");
    expect(buildSystem.getStoredBuild).not.toHaveBeenCalled();
    expect(buildSystem.resolveBuildUnitIdentity).not.toHaveBeenCalled();
    expect(approvalQueue.request).not.toHaveBeenCalled();
    await host.shutdown();
  });

  it("coalesces activation callers and joins their owned build on shutdown", async () => {
    const { host, graphNode, buildSystem } = await makeHarness();
    host.setDeclared([{ source: WEB_SOURCE, ref: "main" }]);
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
    host.setDeclared([{ source: WEB_SOURCE, ref: "main" }]);
    host.acceptPreapprovedTrust((await host.reviewDeclared()).identityKeys);
    const failure = new Error("disk could not read the client source");
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

  it("opens the review of an unreviewed client and runs it once the review is accepted", async () => {
    const admitted = new Set<string>();
    const { host, graphNode, approvalQueue } = await makeHarness({
      isAdmitted: (_repo, ev) => admitted.has(ev),
    });
    approvalQueue.request.mockImplementationOnce(async () => {
      admitted.add("ev-client");
      return "accepted";
    });
    host.setDeclared([{ source: WEB_SOURCE, ref: "main" }]);

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

  it("does not run a declined client and offers its review again only when it is opened again", async () => {
    const { host, graphNode, approvalQueue, buildSystem } = await makeHarness({
      isAdmitted: () => false,
      approvalDecision: "deny",
    });
    host.setDeclared([{ source: WEB_SOURCE, ref: "main" }]);

    await expect(host.ensureActivated(graphNode.name)).resolves.toBe("approval-required");
    await host.whenSettled();
    expect(approvalQueue.request).toHaveBeenCalledTimes(1);
    expect(buildSystem.getStoredBuild).not.toHaveBeenCalled();
    expect(host.registry.get(graphNode.name)?.status).not.toBe("running");

    await expect(host.ensureActivated(graphNode.name)).resolves.toBe("approval-required");
    expect(approvalQueue.request).toHaveBeenCalledTimes(2);
    await host.shutdown();
  });

  it("announces the same build again and retires a client without touching its history", async () => {
    const { host, graphNode, eventService } = await makeHarness();
    installClient(host, graphNode);

    await host.reannounce(WEB_NAME);
    expect(eventService.emit).toHaveBeenCalledWith(
      "supervision:changed",
      expect.objectContaining({
        change: "adopted",
        artifact: expect.objectContaining({ buildKey: "client-key" }),
      })
    );
    await host.retire(WEB_NAME);
    expect(host.registry.get(WEB_NAME)).toMatchObject({
      status: "stopped",
      activeBundleKey: "client-key",
    });
    expect(eventService.emit).toHaveBeenCalledWith("clients:changed", { reason: "retired" });
  });

  it("projects every client's state for hosts that start watching late", async () => {
    const { host, graphNode } = await makeHarness();
    installClient(host, graphNode, { capabilities: ["notifications", "panel-hosting"] });

    expect(host.supervisionSnapshot()).toEqual([
      expect.objectContaining({
        identity: { kind: "client", entityId: WEB_NAME },
        client: {
          id: "browser",
          runtime: "web",
          // panel-hosting is device-level and the client is trusted in the harness.
          grantedCapabilities: ["notifications", "panel-hosting"],
        },
      }),
    ]);
  });
});

describe("ClientHost.listClients", () => {
  async function multiHarness() {
    const harness = await makeHarness();
    const terminal = createClientNode(harness.workspacePath, "clients/terminal-browser", {
      name: "@workspace-clients/terminal-browser",
      block: terminalBlock(),
    });
    const mobile = createClientNode(harness.workspacePath, "clients/mobile-browser", {
      name: "@workspace-clients/mobile-browser",
      block: reactNativeBlock(),
    });
    const chat = createClientNode(harness.workspacePath, "clients/chat-desktop", {
      name: "@workspace-clients/chat-desktop",
      block: webBlock({
        id: "chat",
        title: "Chat",
        capabilities: { required: ["panel-hosting"], optional: [] },
        intents: [{ name: "open", kind: "foreground" }],
      }),
    });
    const nodes = [harness.graphNode, terminal, mobile, chat];
    harness.buildSystem.getGraph.mockReturnValue({ allNodes: () => nodes } as never);
    harness.host.setDeclared(nodes.map((node) => ({ source: node.relativePath, ref: "main" })));
    return { ...harness, terminal, mobile, chat };
  }

  it("lists the declared clients as one host sees them, default first", async () => {
    const { host, chat } = await multiHarness();
    const listings = await host.listClients(desktopHost());

    expect(listings.map((listing) => [listing.source, listing.isDefault])).toEqual([
      [WEB_SOURCE, true],
      ["clients/mobile-browser", false],
      ["clients/terminal-browser", false],
      ["clients/chat-desktop", false],
    ]);
    expect(listings[0]).toMatchObject({
      id: "browser",
      runtime: "web",
      title: "Vibestudio",
      hostAbi: "web-host-1",
      status: "not-built",
      trusted: true,
      activeBuildKey: null,
      canRollback: false,
    });
    expect(listings[0]).not.toHaveProperty("unavailableReason");
    expect(listings.find((listing) => listing.source === chat.relativePath)).toMatchObject({
      trusted: false,
      intents: [{ name: "open", kind: "foreground" }],
      // A device-level capability is reserved for trust.clients members.
      unavailableReason: expect.stringContaining(
        "which only clients listed in trust.clients receive"
      ),
    });
  });

  it("explains why a host cannot run a client", async () => {
    const { host } = await multiHarness();
    const listings = await host.listClients(desktopHost());

    expect(listings.find((l) => l.source === "clients/terminal-browser")?.unavailableReason).toBe(
      "desktop hosts do not run terminal clients"
    );
    expect(
      (await host.listClients(desktopHost({ runtimes: { web: "web-host-2" } }))).find(
        (l) => l.source === WEB_SOURCE
      )
    ).toMatchObject({
      unavailableReason: expect.stringContaining(
        "needs web-host-1; this host implements web-host-2"
      ),
    });
  });

  it("reports the terminal command and the host's own default", async () => {
    const { host, terminal } = await multiHarness();
    const block = terminal.manifest.client as ClientManifestBlock;
    block.integration = { terminal: { command: "chat" } };
    const listings = await host.listClients(terminalHost());
    expect(listings[0]).toMatchObject({
      source: "clients/terminal-browser",
      isDefault: true,
      terminalCommand: "chat",
    });
    expect(listings.find((l) => l.source === WEB_SOURCE)?.unavailableReason).toBe(
      "terminal hosts do not run web clients"
    );
  });

  it("projects the runnable clients' intents as the integration snapshot", async () => {
    const { host } = await multiHarness();
    const snapshot = await host.integrationSnapshot(desktopHost());
    expect(snapshot.clients.map((client) => client.id)).toEqual(["browser"]);
    expect(snapshot.clients[0]).toMatchObject({ title: "Vibestudio" });
  });
});

describe("ClientHost.launch", () => {
  const baseRequest = () => ({ host: desktopHost(), select: { default: true as const } });

  it("is unavailable outside the System workspace", async () => {
    const { host } = await makeHarness({ isSystemWorkspace: () => false });
    await expect(host.launch(baseRequest())).resolves.toEqual({
      state: "unavailable",
      reason: "Clients run only from the System workspace",
    });
  });

  it("is unavailable for a selection that is not declared", async () => {
    const { host } = await makeHarness();
    host.setDeclared([{ source: WEB_SOURCE, ref: "main" }]);
    await expect(host.launch({ host: desktopHost(), select: { id: "ghost" } })).resolves.toEqual({
      state: "unavailable",
      reason: "No web client with id ghost is declared",
    });
    await expect(
      host.launch({ host: desktopHost(), select: { source: "clients/ghost" } })
    ).resolves.toEqual({ state: "unavailable", reason: "Client clients/ghost is not declared" });
  });

  it("is unavailable when the host cannot run the client, naming what is missing", async () => {
    const { host, buildSystem } = await makeHarness({
      block: webBlock({ capabilities: { required: ["tray"], optional: [] } }),
    });
    host.setDeclared([{ source: WEB_SOURCE, ref: "main" }]);
    const result = await host.launch(baseRequest());
    expect(result).toMatchObject({
      state: "unavailable",
      reason: expect.stringContaining("requires tray, which this host does not implement"),
      missing: { capabilities: ["tray"] },
    });
    expect(buildSystem.getStoredBuild).not.toHaveBeenCalled();

    await expect(
      host.launch({
        host: desktopHost({ runtimes: { web: "web-host-9" } }),
        select: { default: true },
      })
    ).resolves.toMatchObject({ state: "unavailable", missing: { hostAbi: "web-host-1" } });
  });

  it("refuses a device-level capability for a client absent from trust.clients", async () => {
    const { host } = await makeHarness({
      trusted: [],
      block: webBlock({ capabilities: { required: ["panel-hosting"], optional: [] } }),
    });
    host.setDeclared([{ source: WEB_SOURCE, ref: "main" }]);
    await expect(host.launch(baseRequest())).resolves.toMatchObject({
      state: "unavailable",
      missing: { capabilities: ["panel-hosting"] },
    });
  });

  it("reports the runtime's extension preparation before building anything", async () => {
    const preparations: RuntimePreparation[] = [
      { state: "approval-required", sources: ["extensions/react-native"] },
      { state: "preparing", reason: "starting extensions/react-native" },
      { state: "unavailable", reason: "Required extension is not installed" },
    ];
    for (const preparation of preparations) {
      const { host, buildSystem, approvalQueue } = await makeHarness({
        prepareRuntime: async () => preparation,
      });
      host.setDeclared([{ source: WEB_SOURCE, ref: "main" }]);
      approvalQueue.listPending.mockReturnValue([
        {
          kind: "unit-install-review",
          approvalId: "review-ext",
          parts: [{ repoPath: "extensions/react-native" }, { repoPath: "extensions/other" }],
        } as never,
      ]);
      const result = await host.launch(baseRequest());
      if (preparation.state === "approval-required") {
        expect(result).toMatchObject({
          state: "approval-required",
          approvals: [expect.objectContaining({ approvalId: "review-ext" })],
        });
      } else if (preparation.state === "preparing") {
        expect(result).toEqual({
          state: "preparing",
          phase: "extensions",
          reason: preparation.reason,
        });
      } else if (preparation.state === "unavailable") {
        expect(result).toEqual({ state: "unavailable", reason: preparation.reason });
      }
      expect(buildSystem.getStoredBuild).not.toHaveBeenCalled();
    }
  });

  it("returns approval-required with the client's open review while it is unreviewed", async () => {
    const { host, approvalQueue } = await makeHarness({ isAdmitted: () => false });
    approvalQueue.listPending.mockReturnValue([
      {
        kind: "unit-install-review",
        approvalId: "review-client",
        parts: [{ repoPath: WEB_SOURCE }],
      } as never,
    ]);
    host.setDeclared([{ source: WEB_SOURCE, ref: "main" }]);
    const result = await host.launch(baseRequest());
    expect(result).toMatchObject({
      state: "approval-required",
      approvals: [expect.objectContaining({ approvalId: "review-client" })],
    });
  });

  it("returns unavailable with the original failure when the build fails", async () => {
    const { host, buildSystem } = await makeHarness({ isAdmitted: () => true });
    await declareTrusted(host);
    buildSystem.getStoredBuild.mockRejectedValue(new Error("bundler exploded"));
    await expect(host.launch(baseRequest())).resolves.toEqual({
      state: "unavailable",
      reason: "bundler exploded",
    });
  });

  it("returns the verified artifact set of the exact build with its granted capabilities", async () => {
    const { host, defaultBuild } = await makeHarness({
      isAdmitted: () => true,
      block: webBlock({
        capabilities: { required: ["panel-hosting"], optional: ["notifications", "tray"] },
      }),
    });
    await declareTrusted(host);
    const result = await host.launch({
      host: desktopHost({
        capabilities: ["device-session", "panel-hosting", "notifications", "approval-surface"],
      }),
      select: { default: true },
    });

    expect(result).toEqual({
      state: "ready",
      client: {
        source: WEB_SOURCE,
        id: "browser",
        runtime: "web",
        title: "Vibestudio",
        icon: "🖥️",
        buildKey: "client-key",
        executionDigest: DIGEST,
        effectiveVersion: "ev-client",
        hostAbi: "web-host-1",
        artifacts: [
          {
            path: "index.html",
            role: "primary",
            contentType: "text/html; charset=utf-8",
            integrity: defaultBuild.artifacts[0]!.integrity,
          },
        ],
        // The host lacks `tray`, so the optional capability is denied, not granted.
        grantedCapabilities: ["notifications", "panel-hosting"],
        deniedOptional: ["tray"],
      },
    });
    expect(host.registry.get(WEB_NAME)).toMatchObject({ status: "running" });
  });

  it("selects a foreground intent and rejects unknown parameters", async () => {
    const { host } = await makeHarness({
      isAdmitted: () => true,
      block: webBlock({
        intents: [
          { name: "open", kind: "foreground" },
          { name: "open-panel", kind: "foreground", params: { panel: "string" } },
        ],
      }),
    });
    await declareTrusted(host);
    await expect(
      host.launch({
        host: desktopHost(),
        select: { id: "browser", intent: "open-panel", params: { panel: "panels/chat" } },
      })
    ).resolves.toMatchObject({
      state: "ready",
      client: { intent: { name: "open-panel", params: { panel: "panels/chat" } } },
    });
    await expect(
      host.launch({
        host: desktopHost(),
        select: { id: "browser", intent: "open-panel", params: { nope: "x" } },
      })
    ).resolves.toEqual({
      state: "unavailable",
      reason: "Intent browser/open-panel has no parameter nope",
    });
    await expect(
      host.launch({ host: desktopHost(), select: { id: "browser", intent: "missing" } })
    ).resolves.toMatchObject({ state: "unavailable" });
  });

  it("launches a retained build when asked to roll back", async () => {
    const { host, graphNode, builds, root } = await makeHarness({ isAdmitted: () => true });
    installClient(host, graphNode, {
      activeBundleKey: "client-key-2",
      activeEv: "ev-client-2",
      previousVersions: [{ activeBundleKey: "client-key", activeEv: "ev-client" }],
    });
    builds.set("client-key-2", clientBuild(root, { key: "client-key-2", ev: "ev-client-2" }));
    host.setDeclared([{ source: WEB_SOURCE, ref: "main" }]);
    const result = await host.launch({
      ...{ host: desktopHost(), select: { default: true as const } },
      rollbackTo: "client-key",
    });
    expect(result).toMatchObject({ state: "ready", client: { buildKey: "client-key" } });
  });

  it("launches a React Native client with one verified bundle per platform", async () => {
    const { host, buildSystem, root, builds } = await makeHarness({
      isAdmitted: () => true,
      block: reactNativeBlock(),
    });
    buildSystem.getBuildProviderDetails.mockReturnValue(REACT_NATIVE_PROVIDER);
    const built = clientBuild(root, {
      key: "rn-key",
      ev: "ev-client",
      runtime: "react-native",
      artifacts: [
        { path: "index.android.bundle", body: "android", role: "primary", platform: "android" },
        { path: "index.ios.bundle", body: "ios", role: "primary", platform: "ios" },
        {
          path: "assets/logo.png",
          body: "png",
          role: "asset",
          platform: "ios",
          contentType: "image/png",
        },
      ],
    });
    builds.set("rn-key", built);
    buildSystem.getStoredBuild.mockResolvedValue(built);
    await declareTrusted(host);
    const result = await host.launch({
      host: {
        host: "android",
        hostVersion: "1.0.0",
        runtimes: { "react-native": "rn-host-6" },
        capabilities: ["notifications"],
      },
      select: { source: WEB_SOURCE },
    });
    expect(result).toMatchObject({
      state: "ready",
      client: {
        runtime: "react-native",
        hostAbi: "rn-host-6",
        artifacts: [
          { path: "index.android.bundle", platform: "android", role: "primary" },
          { path: "index.ios.bundle", platform: "ios", role: "primary" },
          { path: "assets/logo.png", platform: "ios", role: "asset" },
        ],
      },
    });
  });
});

describe("ClientHost.prepareDefault", () => {
  it("builds and proves the default client without admitting or activating it", async () => {
    const { host, buildSystem, eventService, approvalQueue } = await makeHarness();
    host.setDeclared([{ source: WEB_SOURCE, ref: "main" }]);

    await expect(host.prepareDefault("desktop")).resolves.toEqual({
      ready: true,
      source: WEB_SOURCE,
      buildKey: "client-key",
    });
    expect(buildSystem.getStoredBuild).toHaveBeenCalledWith(WEB_NAME, "main");
    expect(host.registry.get(WEB_NAME)).toBeNull();
    expect(approvalQueue.request).not.toHaveBeenCalled();
    expect(eventService.emit).not.toHaveBeenCalledWith(
      "supervision:changed",
      expect.objectContaining({ change: "adopted" })
    );
  });

  it("names why a default is not ready", async () => {
    const { host, buildSystem } = await makeHarness();
    host.setDeclared([{ source: WEB_SOURCE, ref: "main" }]);
    // No declared terminal default.
    await expect(host.prepareDefault("terminal")).resolves.toEqual({
      ready: false,
      source: "clients/terminal-browser",
      reason: "clients/terminal-browser is not declared under clients:",
    });
    // A default of the wrong runtime for the host.
    await expect(host.prepareDefault("android")).resolves.toMatchObject({ ready: false });
    // A violated build contract.
    buildSystem.getStoredBuild.mockResolvedValueOnce(
      clientBuild(tempRoot(), { key: "bad", ev: "ev-bad", hostAbi: "web-host-2" })
    );
    await expect(host.prepareDefault("desktop")).resolves.toMatchObject({
      ready: false,
      source: WEB_SOURCE,
      reason: expect.stringContaining("produced for web-host-2"),
    });
  });

  it("refuses a default whose runtime the host does not run", async () => {
    const { host, workspacePath, buildSystem } = await makeHarness();
    // The android default is declared as a web client.
    const misdeclared = createClientNode(workspacePath, "clients/mobile-browser", {
      name: "@workspace-clients/mobile-browser",
      block: webBlock(),
    });
    buildSystem.getGraph.mockReturnValue({ allNodes: () => [misdeclared] } as never);
    host.setDeclared([{ source: "clients/mobile-browser", ref: "main" }]);
    await expect(host.prepareDefault("android")).resolves.toEqual({
      ready: false,
      source: "clients/mobile-browser",
      reason: "clients/mobile-browser is a web client; android hosts run react-native clients",
    });
  });

  it("waits on the runtime's extension review, not the host", async () => {
    const { host } = await makeHarness({
      prepareRuntime: async () => ({
        state: "approval-required",
        sources: ["extensions/react-native"],
      }),
    });
    host.setDeclared([{ source: WEB_SOURCE, ref: "main" }]);
    await expect(host.prepareDefault("desktop")).resolves.toEqual({
      ready: false,
      source: WEB_SOURCE,
      reason: "Waiting for review of extensions/react-native",
    });
  });
});

describe("ClientHost principals", () => {
  async function runningClient(overrides: Partial<Parameters<typeof makeHarness>[0]> = {}) {
    const harness = await makeHarness(overrides);
    installClient(harness.host, harness.graphNode, {
      capabilities: ["notifications", "panel-hosting"],
    });
    return harness;
  }
  const exact = { source: WEB_SOURCE, buildKey: "client-key", executionDigest: DIGEST };

  it("binds a principal to the exact build the host verified", async () => {
    const { host, entityCache } = await runningClient();

    const principal = await host.grantPrincipal("device-1", exact);

    expect(principal).toEqual({
      principalId: "client:browser:web:device-1",
      id: "browser",
      runtime: "web",
      source: WEB_SOURCE,
      buildKey: "client-key",
      effectiveVersion: "ev-client",
    });
    expect(entityCache.resolveActive(principal.principalId)).toMatchObject({
      kind: "client",
      source: { repoPath: WEB_SOURCE, effectiveVersion: "ev-client" },
      activeBuildKey: "client-key",
      activeExecutionDigest: DIGEST,
      status: "active",
    });
    const connectionGrants = new ConnectionGrantService({ entityCache });
    try {
      expect(() => connectionGrants.grant(principal.principalId, "shell:device-1")).not.toThrow();
    } finally {
      connectionGrants.stop();
    }
  });

  it("refuses a principal for any other build, digest or client", async () => {
    const { host, entityCache } = await runningClient();
    await expect(
      host.grantPrincipal("device-1", { ...exact, buildKey: "client-key-old" })
    ).rejects.toThrow("is not the build it runs");
    await expect(
      host.grantPrincipal("device-1", { ...exact, executionDigest: "9".repeat(64) })
    ).rejects.toThrow("is not the build it runs");
    await expect(
      host.grantPrincipal("device-1", { ...exact, source: "clients/other" })
    ).rejects.toThrow("is not running");
    expect(entityCache.listActive()).toEqual([]);
  });

  it("refuses a principal for a client that is not running", async () => {
    const { host, graphNode } = await makeHarness();
    installClient(host, graphNode, { status: "available" });
    host.registry.patch(WEB_NAME, { status: "stopped" });
    await expect(host.grantPrincipal("device-1", exact)).rejects.toThrow("is not running");
  });

  it("registers a distinct principal per device and retires a device's principals together", async () => {
    const { host, entityCache } = await runningClient();
    await host.grantPrincipal("device-1", exact);
    await host.grantPrincipal("device-2", exact);
    expect(
      entityCache
        .listActive()
        .map((record) => record.id)
        .sort()
    ).toEqual(["client:browser:web:device-1", "client:browser:web:device-2"]);
    expect(host.retireDevice("device-1")).toBe(1);
    expect(entityCache.resolveActive("client:browser:web:device-1")).toBeNull();
    expect(entityCache.resolveActive("client:browser:web:device-2")).not.toBeNull();
  });

  it("rejects stale authority when the protected System designation is absent", async () => {
    let system = true;
    const { host, entityCache } = await runningClient({ isSystemWorkspace: () => system });
    const principal = await host.grantPrincipal("device-1", exact);
    expect(host.hasClientCapability(principal.principalId, "notifications")).toBe(true);
    system = false;
    expect(host.hasClientCapability(principal.principalId, "notifications")).toBe(false);
    await expect(host.activateRelease(WEB_NAME)).rejects.toThrow("designated System workspace");
    await expect(host.grantPrincipal("device-2", exact)).rejects.toThrow(
      "designated System workspace"
    );
    expect(entityCache.listActive().map((record) => record.id)).toEqual([principal.principalId]);
  });

  it("runs a background intent as the device's principal of the current build", async () => {
    const { host } = await runningClient();
    await expect(host.intentPrincipal("device-1", WEB_SOURCE)).resolves.toMatchObject({
      principalId: "client:browser:web:device-1",
      buildKey: "client-key",
    });
    await expect(host.intentPrincipal("device-1", "clients/ghost")).rejects.toThrow(
      "has no running build to act for"
    );
  });
});

describe("ClientHost capabilities and trust", () => {
  it("grants a device-level capability only to a client listed in trust.clients", async () => {
    const trusted = await makeHarness({ trusted: [WEB_SOURCE] });
    const untrusted = await makeHarness({ trusted: [] });
    for (const owner of [trusted, untrusted]) {
      installClient(owner.host, owner.graphNode, {
        capabilities: ["notifications", "panel-hosting"],
      });
    }
    const principal = "client:browser:web:device-1";
    expect(trusted.host.hasClientCapability(principal, "panel-hosting")).toBe(true);
    expect(trusted.host.hasClientCapability(principal, "notifications")).toBe(true);
    expect(untrusted.host.hasClientCapability(principal, "panel-hosting")).toBe(false);
    expect(untrusted.host.hasClientCapability(principal, "notifications")).toBe(true);
    expect(untrusted.host.hasClientCapability(principal, "tray")).toBe(false);
    expect(trusted.host.hasClientCapability("client:other:web:device-1", "notifications")).toBe(
      false
    );
    expect(trusted.host.hasClientCapability("not-a-principal", "notifications")).toBe(false);
    expect(untrusted.host.capabilityAuthorizer()).toBeDefined();
  });

  it("strips device-level capabilities from the adoption of an untrusted client", async () => {
    const { host, eventService, graphNode } = await makeHarness({
      trusted: [],
      block: webBlock({
        capabilities: { required: [], optional: ["notifications", "panel-hosting"] },
      }),
    });
    await host.reconcileDeclared([{ source: WEB_SOURCE, ref: "main" }]);
    await host.whenSettled();
    await host.activateRelease(graphNode.name);

    expect(eventService.emit).toHaveBeenCalledWith(
      "supervision:changed",
      expect.objectContaining({
        change: "adopted",
        client: expect.objectContaining({ grantedCapabilities: ["notifications"] }),
      })
    );
  });

  describe("applyTrust", () => {
    async function trustedWithPrincipal() {
      const harness = await makeHarness({
        block: webBlock({
          capabilities: { required: [], optional: ["notifications", "panel-hosting"] },
        }),
      });
      installClient(harness.host, harness.graphNode, {
        capabilities: ["notifications", "panel-hosting"],
      });
      await harness.host.initialize();
      const principal = await harness.host.grantPrincipal("device-1", {
        source: WEB_SOURCE,
        buildKey: "client-key",
        executionDigest: DIGEST,
      });
      harness.eventService.emit.mockClear();
      return { ...harness, principal };
    }

    it("revokes principals, grants and sessions of a client whose device-level capability was withdrawn", async () => {
      const { host, trusted, entityCache, revokePrincipalSessions, eventService, principal } =
        await trustedWithPrincipal();

      trusted.splice(0, trusted.length);
      host.applyTrust();

      expect(revokePrincipalSessions).toHaveBeenCalledExactlyOnceWith(
        principal.principalId,
        "trust-revoked"
      );
      expect(entityCache.resolveActive(principal.principalId)).toBeNull();
      expect(eventService.emit).toHaveBeenCalledWith("clients:changed", { reason: "trust" });
      expect(eventService.emit).toHaveBeenCalledWith(
        "supervision:changed",
        expect.objectContaining({
          identity: { kind: "client", entityId: WEB_NAME },
          client: expect.objectContaining({ grantedCapabilities: ["notifications"] }),
        })
      );
    });

    it("applies a grant at once without revoking any session", async () => {
      const { host, trusted, revokePrincipalSessions, eventService, principal } =
        await trustedWithPrincipal();
      trusted.splice(0, trusted.length);
      host.applyTrust();
      revokePrincipalSessions.mockClear();
      eventService.emit.mockClear();

      trusted.push(WEB_SOURCE);
      host.applyTrust();

      expect(revokePrincipalSessions).not.toHaveBeenCalled();
      expect(host.hasClientCapability(principal.principalId, "panel-hosting")).toBe(true);
      expect(eventService.emit).toHaveBeenCalledWith("clients:changed", { reason: "trust" });
      expect(eventService.emit).toHaveBeenCalledWith(
        "supervision:changed",
        expect.objectContaining({
          client: expect.objectContaining({
            grantedCapabilities: ["notifications", "panel-hosting"],
          }),
        })
      );
    });

    it("does nothing when trust did not change", async () => {
      const { host, revokePrincipalSessions, eventService } = await trustedWithPrincipal();
      host.applyTrust();
      expect(revokePrincipalSessions).not.toHaveBeenCalled();
      expect(eventService.emit).not.toHaveBeenCalled();
    });

    it("closes sessions of every device's principal of a retired client", async () => {
      const { host, revokePrincipalSessions } = await trustedWithPrincipal();
      await host.grantPrincipal("device-2", {
        source: WEB_SOURCE,
        buildKey: "client-key",
        executionDigest: DIGEST,
      });
      await host.retire(WEB_NAME);
      expect(
        revokePrincipalSessions.mock.calls
          .map(([id, reason]) => [id, reason])
          .sort(([a], [b]) => String(a).localeCompare(String(b)))
      ).toEqual([
        ["client:browser:web:device-1", "retired"],
        ["client:browser:web:device-2", "retired"],
      ]);
    });
  });

  describe("trustDeltaForCommit", () => {
    const COMMIT = "state:candidate";
    const deviceBlock = (extra: ClientCapability[] = []) =>
      webBlock({
        title: "Browser",
        capabilities: { required: ["panel-hosting"], optional: ["notifications", ...extra] },
      });

    async function deltaHarness(
      candidate: {
        clients?: string[];
        trust?: string[];
        manifests?: Record<string, ClientManifestBlock>;
      },
      current: { trusted?: string[]; block?: ClientManifestBlock } = {}
    ) {
      const manifests: Record<string, ClientManifestBlock> = candidate.manifests ?? {
        [WEB_SOURCE]: deviceBlock(),
      };
      const harness = await makeHarness({
        trusted: current.trusted ?? [WEB_SOURCE],
        block: current.block ?? deviceBlock(),
        readWorkspaceFileAtState: async (_state, filePath) => {
          if (filePath === "meta/vibestudio.yml") {
            return workspaceYaml({
              clients: candidate.clients ?? Object.keys(manifests),
              ...(candidate.trust ? { trust: candidate.trust } : { trust: [] }),
            });
          }
          const source = Object.keys(manifests).find((s) => filePath === `${s}/package.json`);
          return source
            ? JSON.stringify(
                manifestFor(`@workspace-clients/${path.basename(source)}`, manifests[source]!)
              )
            : null;
        },
      });
      harness.buildSystem.resolveBuildUnitIdentity.mockImplementation((async (source: string) => ({
        unitPath: source,
        unitName: `@workspace-clients/${path.basename(source)}`,
        stateHash: COMMIT,
        manifest: {},
        serviceBindings: [],
        serviceReviews: [],
        effectiveVersion: `ev-${path.basename(source)}`,
        dependencyEvs: {},
        externalDeps: {},
      })) as never);
      harness.host.setDeclared([{ source: WEB_SOURCE, ref: "main" }]);
      return harness;
    }

    it("is empty when no client's device-level capabilities change", async () => {
      const { host } = await deltaHarness({ trust: [WEB_SOURCE] });
      await expect(host.trustDeltaForCommit(COMMIT)).resolves.toEqual([]);
    });

    it("is empty when only ordinary capabilities change", async () => {
      const { host } = await deltaHarness({
        trust: [WEB_SOURCE],
        manifests: { [WEB_SOURCE]: deviceBlock(["tray"]) },
      });
      await expect(host.trustDeltaForCommit(COMMIT)).resolves.toEqual([]);
    });

    it("reports a client added to trust.clients with the device-level capabilities it gains", async () => {
      const { host } = await deltaHarness({ trust: [WEB_SOURCE] }, { trusted: [] });
      const delta = await host.trustDeltaForCommit(COMMIT);
      expect(delta).toEqual([
        {
          source: WEB_SOURCE,
          title: "Browser",
          icon: "🖥️",
          runtime: "web",
          gained: [
            {
              capability: "panel-hosting",
              summary: "host panels and render host chrome",
            },
          ],
          lost: [],
          effectiveVersion: "ev-desktop-browser",
        },
      ]);
    });

    it("reports a client removed from trust.clients with what it loses", async () => {
      const { host } = await deltaHarness({ trust: [] }, { trusted: [WEB_SOURCE] });
      const delta = await host.trustDeltaForCommit(COMMIT);
      expect(delta).toEqual([
        expect.objectContaining({
          source: WEB_SOURCE,
          gained: [],
          lost: [expect.objectContaining({ capability: "panel-hosting" })],
        }),
      ]);
    });

    it("reports a trusted client whose declaration widens to another device-level capability", async () => {
      const { host } = await deltaHarness({
        trust: [WEB_SOURCE],
        manifests: {
          [WEB_SOURCE]: webBlock({
            title: "Browser",
            capabilities: { required: ["panel-hosting", "hub-control"], optional: [] },
          }),
        },
      });
      const delta = await host.trustDeltaForCommit(COMMIT);
      expect(delta).toEqual([
        expect.objectContaining({
          source: WEB_SOURCE,
          gained: [expect.objectContaining({ capability: "hub-control" })],
          lost: [],
        }),
      ]);
    });

    it("reports a client dropped from the declared clients as losing its device-level capabilities", async () => {
      const { host } = await deltaHarness({
        clients: [],
        trust: [WEB_SOURCE],
        manifests: {},
      });
      const delta = await host.trustDeltaForCommit(COMMIT);
      expect(delta).toEqual([
        expect.objectContaining({
          source: WEB_SOURCE,
          gained: [],
          lost: [expect.objectContaining({ capability: "panel-hosting" })],
          effectiveVersion: null,
        }),
      ]);
    });

    it("reports a newly declared, trusted client", async () => {
      const harness = await deltaHarness({
        trust: [WEB_SOURCE, "clients/chat-desktop"],
        manifests: {
          [WEB_SOURCE]: deviceBlock(),
          "clients/chat-desktop": webBlock({
            id: "chat",
            title: "Chat",
            capabilities: { required: ["approval-surface"], optional: [] },
          }),
        },
      });
      const delta = await harness.host.trustDeltaForCommit(COMMIT);
      expect(
        delta.map((change) => [change.source, change.gained.map((g) => g.capability)])
      ).toEqual([["clients/chat-desktop", ["approval-surface"]]]);
    });

    it("refuses a candidate whose client manifest is invalid", async () => {
      const { host } = await deltaHarness({
        trust: [WEB_SOURCE],
        manifests: { [WEB_SOURCE]: { ...deviceBlock(), preload: "x" } as ClientManifestBlock },
      });
      await expect(host.trustDeltaForCommit(COMMIT)).rejects.toThrow('unknown field "preload"');
    });
  });
});

describe("ClientHost runtimes", () => {
  ledgerTest("execution.client-terminal", async () => {
    // A terminal client is built, admitted and activated like any other: no
    // server process exists. The terminal host imports the exact module through
    // a device-scoped principal bound to the active build.
    const { host, buildSystem, eventService, approvalQueue, entityCache, graphNode, builds, root } =
      await makeHarness({ isAdmitted: () => true, block: terminalBlock() });
    const terminalBuild = clientBuild(root, {
      key: "terminal-key",
      ev: "ev-client",
      runtime: "terminal",
    });
    builds.set("terminal-key", terminalBuild);
    buildSystem.getStoredBuild.mockResolvedValueOnce(terminalBuild);

    await host.reconcileDeclared([{ source: graphNode.relativePath, ref: "main" }]);
    await host.whenSettled();

    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "unit-install-review",
        units: [
          expect.objectContaining({
            unitKind: "client",
            unitName: graphNode.name,
            runtime: "terminal",
            source: { kind: "workspace-repo", repo: graphNode.relativePath, ref: "main" },
          }),
        ],
      })
    );
    expect(host.registry.get(graphNode.name)).toMatchObject({
      runtime: "terminal",
      activeBundleKey: "terminal-key",
      capabilities: ["clipboard"],
      status: "available",
    });

    await host.activateRelease(graphNode.name);

    expect(host.registry.get(graphNode.name)).toMatchObject({ status: "running", lastError: null });
    expect(eventService.emit).toHaveBeenCalledWith(
      "supervision:changed",
      expect.objectContaining({
        identity: { kind: "client", entityId: graphNode.name },
        source: graphNode.relativePath,
        change: "adopted",
        artifact: expect.objectContaining({ buildKey: "terminal-key" }),
        client: expect.objectContaining({ id: "browser", runtime: "terminal" }),
      })
    );

    const principal = await host.grantPrincipal("device-1", {
      source: graphNode.relativePath,
      buildKey: "terminal-key",
      executionDigest: DIGEST,
    });
    expect(principal).toEqual({
      principalId: "client:browser:terminal:device-1",
      id: "browser",
      runtime: "terminal",
      source: graphNode.relativePath,
      buildKey: "terminal-key",
      effectiveVersion: "ev-client",
    });
    expect(entityCache.resolveActive(principal.principalId)).toMatchObject({
      kind: "client",
      activeBuildKey: "terminal-key",
      activeExecutionDigest: DIGEST,
      status: "active",
    });
    expect(host.hasClientCapability(principal.principalId, "clipboard")).toBe(true);
    expect(host.principals.retireDevice("device-1")).toBe(1);
    expect(entityCache.resolveActive(principal.principalId)).toBeNull();
  });

  ledgerTest("execution.client-react-native", async () => {
    const { host, buildSystem, graphNode, builds, root } = await makeHarness({
      block: reactNativeBlock(),
    });
    buildSystem.getBuildProviderDetails.mockReturnValue(REACT_NATIVE_PROVIDER);
    // A build for one platform is a complete build: platforms are independent.
    const rnBuild = clientBuild(root, {
      key: "rn-android-only-key",
      ev: "ev-client",
      runtime: "react-native",
      artifacts: [
        { path: "index.android.bundle", body: "bundle", role: "primary", platform: "android" },
      ],
    });
    builds.set("rn-android-only-key", rnBuild);
    buildSystem.getStoredBuild.mockResolvedValueOnce(rnBuild);

    await host.reconcileDeclared([{ source: graphNode.relativePath, ref: "main" }]);
    await host.whenSettled();

    expect(host.registry.get(graphNode.name)).toMatchObject({
      runtime: "react-native",
      status: "available",
      activeBundleKey: "rn-android-only-key",
      lastError: null,
    });
  });

  it("fails closed before adopting a React Native build without provider identity", async () => {
    const { host, buildSystem, graphNode, root } = await makeHarness({ block: reactNativeBlock() });
    buildSystem.getStoredBuild.mockResolvedValueOnce(
      clientBuild(root, { key: "rn-key", ev: "ev-client", runtime: "react-native", provider: null })
    );
    await host.reconcileDeclared([{ source: graphNode.relativePath, ref: "main" }]);
    await host.whenSettled();
    expect(host.registry.get(graphNode.name)).toMatchObject({
      status: "error",
      activeBundleKey: null,
      lastError: expect.stringContaining("does not identify the build provider"),
    });
  });

  it("fails closed before adopting a React Native build whose primary bundle has no platform", async () => {
    const { host, buildSystem, graphNode, root } = await makeHarness({ block: reactNativeBlock() });
    buildSystem.getStoredBuild.mockResolvedValueOnce(
      clientBuild(root, {
        key: "rn-key",
        ev: "ev-client",
        runtime: "react-native",
        artifacts: [{ path: "index.bundle", body: "x", role: "primary" }],
      })
    );
    await host.reconcileDeclared([{ source: graphNode.relativePath, ref: "main" }]);
    await host.whenSettled();
    expect(host.registry.get(graphNode.name)).toMatchObject({
      status: "error",
      lastError: expect.stringContaining("has no mobile platform"),
    });
  });

  it("fails closed before activating a stored build whose artifacts lack integrity", async () => {
    const { host, graphNode, builds } = await makeHarness();
    installClient(host, graphNode, { status: "available" });
    const stored = builds.get("client-key")!;
    stored.artifacts = stored.artifacts.map((artifact) => ({
      ...artifact,
      integrity: undefined,
    })) as never;
    await expect(host.activateRelease(graphNode.name)).rejects.toThrow("is missing integrity");
    expect(host.registry.get(graphNode.name)?.status).toBe("available");
  });

  it("re-runs a changed provider through the build instead of trusting the adopted build", async () => {
    const { host, providerChangeCallbacks, eventService } = await makeHarness({
      block: reactNativeBlock(),
    });
    await host.initialize();
    for (const callback of providerChangeCallbacks) callback();
    await flushAsyncWork();
    expect(eventService.emit).toHaveBeenCalledWith("clients:changed", { reason: "build" });
  });
});

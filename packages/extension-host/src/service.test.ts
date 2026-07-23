import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import type { ProtectedPublicationEvent } from "@vibestudio/shared/protectedPublicationEvents";
import { WORKSPACE_SYSTEM_EPOCH } from "@vibestudio/shared/vcs/systemEpoch";
import { EXTENSION_RUNTIME_ABI_VERSION } from "@vibestudio/shared/extensionRuntimeAbi";

import { ExtensionHost } from "./service.js";
import type { ExtensionHostDeps } from "./service.js";

function publicationEvent(): ProtectedPublicationEvent {
  return {
    publicationId: "publication:test",
    resultHostRefsBasisDigest: "host-refs:test",
    appliedAt: 42,
    workspaceStateHash: "state:published",
    changedPaths: ["extensions/git-tools/index.ts"],
    repositories: [
      {
        repoPath: "extensions/git-tools",
        previousStateHash: "state:previous",
        nextStateHash: "state:next",
        fileChanges: [],
      },
    ],
  };
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-extension-host-"));
}

function panelCtx(callerId = "panel-1") {
  return {
    caller: createVerifiedCaller(callerId, "panel", {
      callerId,
      callerKind: "panel",
      repoPath: "panels/test",
      effectiveVersion: "ev-test",
    }),
  };
}

function doCtx(callerId = "do:workers/agent-worker:AiChatWorker:agent-1") {
  return {
    caller: createVerifiedCaller(callerId, "do", {
      callerId,
      callerKind: "do",
      repoPath: "workers/agent-worker",
      effectiveVersion: "ev-agent",
    }),
  };
}

function makeHost(
  overrides: {
    approvalDecision?: "once" | "session" | "version" | "deny";
    activeEv?: string | null;
    depEv?: string | null;
    activeDepEv?: string | null;
    activeExternalDeps?: Record<string, string>;
    candidateExternalDeps?: Record<string, string>;
    activeRuntimeDepsKey?: string | null;
    extensionTransport?: { call: ReturnType<typeof vi.fn> };
    buildTargets?: string[];
    registerBuildProvider?: ReturnType<typeof vi.fn>;
    unregisterBuildProvider?: ReturnType<typeof vi.fn>;
    recordUnitLog?: ReturnType<typeof vi.fn>;
    getContextIdForCaller?: (callerId: string) => string | null;
    resolveProviderExtensionName?: (provider: string) => string | null;
    providerSlots?: readonly string[];
    hostProviderContracts?: ExtensionHostDeps["hostProviderContracts"];
    sourceProviderContracts?: Record<string, { methods: string[] }>;
    activeProviderContracts?: Record<string, { methods: string[] }>;
    candidateProviderContracts?: Record<string, { methods: string[] }>;
    readWorkspaceFileAtState?: ExtensionHostDeps["readWorkspaceFileAtState"];
    gitDefaultBranch?: "main" | "master";
    installed?: boolean;
    status?: "running" | "stopped" | "building" | "error" | "pending-approval";
    activeBundleKey?: string | null;
    sealedBuildIdentity?: boolean;
    activationEvents?: string[];
  } = {}
) {
  const statePath = tempDir();
  const extensionNode = {
    name: "@workspace-extensions/git-tools",
    kind: "extension",
    relativePath: "extensions/git-tools",
    path: path.join(statePath, "source", "extensions", "git-tools"),
    dependencies: overrides.candidateExternalDeps ?? {},
    internalDeps: ["@workspace/runtime"],
    manifest: {
      displayName: "Git Tools",
      extension: {
        activationEvents: overrides.activationEvents ?? ["*"],
        providerContracts: overrides.sourceProviderContracts ?? {},
        ...(overrides.buildTargets
          ? { contributes: { buildTargets: overrides.buildTargets } }
          : {}),
      },
    },
  };
  fs.mkdirSync(extensionNode.path, { recursive: true });
  fs.writeFileSync(
    path.join(extensionNode.path, "package.json"),
    JSON.stringify({
      name: extensionNode.name,
      version: "1.0.0",
      vibestudio: {
        displayName: "Git Tools",
        extension: {
          activationEvents: overrides.activationEvents ?? ["*"],
          providerContracts: overrides.sourceProviderContracts ?? {},
          ...(overrides.buildTargets
            ? { contributes: { buildTargets: overrides.buildTargets } }
            : {}),
        },
        authority: { requests: [], evalCeilings: [] },
      },
    })
  );
  if (overrides.gitDefaultBranch) {
    execFileSync("git", ["-c", `init.defaultBranch=${overrides.gitDefaultBranch}`, "init", "-q"], {
      cwd: extensionNode.path,
    });
    execFileSync("git", ["add", "package.json"], { cwd: extensionNode.path });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Vibestudio Test",
        "-c",
        "user.email=test@vibestudio.local",
        "commit",
        "-q",
        "-m",
        "initial extension",
      ],
      { cwd: extensionNode.path }
    );
  }
  const approvalQueue = {
    request: vi.fn(async () => overrides.approvalDecision ?? "once"),
  };
  const eventService = { emit: vi.fn(), getOrCreateSubscriber: vi.fn(), subscribe: vi.fn() };
  const buildArtifacts = (key: string) => [
    {
      path: "bundle.js",
      role: "primary",
      contentType: "text/javascript; charset=utf-8",
      encoding: "utf8",
      content: `export default ${JSON.stringify(key)};`,
    },
  ];
  const buildSystem = {
    getBuild: vi.fn(async () => ({
      dir: path.join(statePath, "builds", "candidate-key"),
      artifacts: buildArtifacts("candidate-key"),
      metadata: {
        ev: "ev-candidate",
        sourceStateHash: "state:test",
        execution: { executionDigest: "c".repeat(64) },
        authority: {
          requests: [
            {
              capability: "service:extensions.ready",
              resource: { kind: "prefix" as const, prefix: "" },
              tier: "gated" as const,
              evidence: "intentional-broad" as const,
            },
          ],
          evalCeilings: [],
        },
        details: {
          kind: "extension",
          runtimeDepsKey: "runtime-candidate",
          runtimeAbi: EXTENSION_RUNTIME_ABI_VERSION,
          providerContracts:
            overrides.candidateProviderContracts ?? overrides.sourceProviderContracts ?? {},
          externalDeps: {},
        },
      },
    })),
    getBuildByKey: vi.fn((key: string) =>
      key === "bundle-key" || key === "candidate-key"
        ? {
            dir: path.join(statePath, "builds", key),
            artifacts: buildArtifacts(key),
            metadata: {
              ev: key === "candidate-key" ? "ev-candidate" : (overrides.activeEv ?? "ev-current"),
              sourceStateHash: "state:test",
              ...(overrides.sealedBuildIdentity === false
                ? {}
                : {
                    execution: {
                      executionDigest: (key === "candidate-key" ? "c" : "a").repeat(64),
                    },
                    authority: {
                      requests: [
                        {
                          capability: "service:extensions.ready",
                          resource: { kind: "prefix" as const, prefix: "" },
                          tier: "gated" as const,
                          evidence: "intentional-broad" as const,
                        },
                      ],
                      evalCeilings: [],
                    },
                  }),
              details: {
                kind: "extension",
                runtimeDepsKey: key === "candidate-key" ? "runtime-candidate" : "runtime-key",
                runtimeAbi: EXTENSION_RUNTIME_ABI_VERSION,
                providerContracts:
                  key === "candidate-key"
                    ? (overrides.candidateProviderContracts ??
                      overrides.sourceProviderContracts ??
                      {})
                    : (overrides.activeProviderContracts ?? {}),
                externalDeps: overrides.activeExternalDeps ?? {},
              },
            },
          }
        : null
    ),
    getEffectiveVersion: vi.fn((name: string) => {
      if (name === extensionNode.name) return overrides.activeEv ?? "ev-current";
      if (name === "@workspace/runtime") return overrides.depEv ?? "ev-runtime";
      return null;
    }),
    resolveBuildUnitIdentity: vi.fn(async () => ({
      unitPath: extensionNode.relativePath,
      unitName: extensionNode.name,
      effectiveVersion: overrides.activeEv ?? "ev-current",
      dependencyEvs: { "@workspace/runtime": overrides.depEv ?? "ev-runtime" },
      externalDeps: overrides.candidateExternalDeps ?? {},
    })),
    getExternalDeps: vi.fn((name: string) => {
      if (name === extensionNode.name) return overrides.candidateExternalDeps ?? {};
      return {};
    }),
    getGraph: () => ({ allNodes: () => [extensionNode] }),
    onPushBuild: vi.fn(),
  };
  const host = new ExtensionHost({
    statePath,
    workspacePath: path.join(statePath, "source"),
    workspaceId: "workspace-test",
    buildSystem,
    tokenManager: { ensureToken: vi.fn() } as any,
    eventService: eventService as any,
    approvalQueue,
    getGatewayUrl: () => "http://127.0.0.1:3000",
    getContextIdForCaller: overrides.getContextIdForCaller,
    resolveProviderExtensionName: overrides.resolveProviderExtensionName ?? (() => null),
    providerSlots: overrides.providerSlots ?? [],
    hostProviderContracts: overrides.hostProviderContracts ?? {},
    readWorkspaceFileAtState: async (stateHash, filePath) =>
      filePath === "extensions/git-tools/package.json"
        ? fs.readFileSync(path.join(extensionNode.path, "package.json"), "utf8")
        : (await overrides.readWorkspaceFileAtState?.(stateHash, filePath)) ?? null,
    extensionTransport: overrides.extensionTransport ?? {
      call: vi.fn(async () => {
        throw new Error("extensionTransport.call should not be invoked in this test");
      }),
    },
    registerBuildProvider: overrides.registerBuildProvider,
    unregisterBuildProvider: overrides.unregisterBuildProvider,
    recordUnitLog: overrides.recordUnitLog,
  });
  if (overrides.installed !== false) {
    host.registry.upsert({
      unitKind: "extension",
      name: extensionNode.name,
      version: "1.0.0",
      source: { kind: "workspace-repo", repo: extensionNode.relativePath, ref: "main" },
      installedAt: Date.now(),
      activeEv: overrides.activeEv ?? "ev-current",
      activeSourceHash: "abc123",
      activeBundleKey:
        overrides.activeBundleKey === undefined ? "bundle-key" : overrides.activeBundleKey,
      activeDependencyEvs: {
        "@workspace/runtime": overrides.activeDepEv ?? overrides.depEv ?? "ev-runtime",
      },
      activeExternalDeps: overrides.activeExternalDeps ?? {},
      activeRuntimeDepsKey:
        overrides.activeRuntimeDepsKey === undefined
          ? "runtime-key"
          : overrides.activeRuntimeDepsKey,
      status: overrides.status ?? "running",
      lastError: overrides.status === "error" ? "previous failure" : null,
    });
  }
  return { host, approvalQueue, buildSystem, extensionNode, eventService, statePath };
}

describe("ExtensionHost invocation attribution", () => {
  it("attributes an extension to its exact active sealed build authority", () => {
    const { host, extensionNode } = makeHost();

    expect(host.resolveCodeIdentity(extensionNode.name)).toEqual({
      callerId: extensionNode.name,
      callerKind: "extension",
      repoPath: "extensions/git-tools",
      effectiveVersion: "ev-current",
      executionDigest: "a".repeat(64),
      requested: [
        {
          capability: "service:extensions.ready",
          resource: { kind: "prefix", prefix: "" },
          tier: "gated",
          evidence: "intentional-broad",
        },
      ],
      evalCeilings: [],
    });
  });

  it("does not invent extension code identity without sealed build authority", () => {
    const { host, extensionNode } = makeHost({ sealedBuildIdentity: false });

    expect(host.resolveCodeIdentity(extensionNode.name)).toBeNull();
  });

  it("lists canonical and short extension identifiers", async () => {
    const { host, extensionNode } = makeHost();
    const service = host.createServiceDefinition();

    await expect(service.handler(panelCtx(), "list", [])).resolves.toEqual([
      expect.objectContaining({
        name: extensionNode.name,
        shortName: "git-tools",
        source: expect.objectContaining({ repo: "extensions/git-tools" }),
      }),
    ]);
  });

  it("invokes extensions through a configured provider slot", async () => {
    const extensionTransport = {
      call: vi.fn(async () => "ok"),
    };
    const { host, extensionNode } = makeHost({
      extensionTransport,
      resolveProviderExtensionName: (provider) =>
        provider === "gitInterop" ? "@workspace-extensions/git-tools" : null,
      hostProviderContracts: { gitInterop: ["upstreamStatus"] },
      activeProviderContracts: {
        gitInterop: { methods: ["upstreamStatus"] },
      },
    });
    vi.spyOn(host.processes, "isRunning").mockReturnValue(true);

    await expect(
      host.invokeProvider(panelCtx("panel-1"), "gitInterop", "upstreamStatus", [[]])
    ).resolves.toBe("ok");

    expect(extensionTransport.call).toHaveBeenCalledWith(
      extensionNode.name,
      "extension.invokeProvider",
      [
        "gitInterop",
        "upstreamStatus",
        [[]],
        expect.objectContaining({
          extensionName: extensionNode.name,
          method: "providers.gitInterop.upstreamStatus",
        }),
      ]
    );
  });

  it("fails internal provider dispatch when the approved build does not declare that contract", async () => {
    const extensionTransport = { call: vi.fn(async () => "unexpected") };
    const { host } = makeHost({
      extensionTransport,
      resolveProviderExtensionName: (provider) =>
        provider === "gitInterop" ? "@workspace-extensions/git-tools" : null,
      hostProviderContracts: { gitInterop: ["upstreamStatus"] },
      activeProviderContracts: {},
    });
    vi.spyOn(host.processes, "isRunning").mockReturnValue(true);

    await expect(
      host.invokeProvider(panelCtx("panel-1"), "gitInterop", "upstreamStatus", [[]])
    ).rejects.toMatchObject({ code: "EPROTO" });
    expect(extensionTransport.call).not.toHaveBeenCalled();
  });

  it("rejects direct invocation from the approved provider contract even when its slot is unconfigured", async () => {
    const extensionTransport = { call: vi.fn(async () => "unexpected") };
    const { host } = makeHost({
      extensionTransport,
      hostProviderContracts: { gitInterop: ["upstreamStatus", "publishRepo"] },
      activeProviderContracts: {
        gitInterop: { methods: ["upstreamStatus", "publishRepo"] },
      },
    });
    vi.spyOn(host.processes, "isRunning").mockReturnValue(true);

    await expect(
      host
        .createServiceDefinition()
        .handler(panelCtx("panel-1"), "invoke", [
          "@workspace-extensions/git-tools",
          "upstreamStatus",
          [],
        ])
    ).rejects.toMatchObject({ code: "EACCES" });
    await expect(
      host.invoke(panelCtx("panel-1"), "extensions/git-tools", "upstreamStatus", [])
    ).rejects.toMatchObject({ code: "EACCES" });
    await expect(
      host
        .createServiceDefinition()
        .handler(panelCtx("panel-1"), "invokeStream", [
          "@workspace-extensions/git-tools",
          "upstreamStatus",
          [],
        ])
    ).rejects.toMatchObject({ code: "EACCES" });
    expect(extensionTransport.call).not.toHaveBeenCalled();
  });

  it("rejects public provider invocation by provider slot and method", async () => {
    const extensionTransport = { call: vi.fn(async () => "unexpected") };
    const { host } = makeHost({
      extensionTransport,
      resolveProviderExtensionName: (provider) =>
        provider === "gitInterop" ? "@workspace-extensions/git-tools" : null,
      hostProviderContracts: { gitInterop: ["upstreamStatus", "publishRepo"] },
    });
    vi.spyOn(host.processes, "isRunning").mockReturnValue(true);

    await expect(
      host
        .createServiceDefinition()
        .handler(panelCtx("panel-1"), "invokeProvider", ["gitInterop", "publishRepo", []])
    ).rejects.toMatchObject({ code: "EACCES" });
    expect(extensionTransport.call).not.toHaveBeenCalled();
  });

  it("does not reserve the same method name on a different provider slot", async () => {
    const extensionTransport = { call: vi.fn(async () => "ok") };
    const { host } = makeHost({
      extensionTransport,
      resolveProviderExtensionName: (provider) =>
        provider === "claudeCode" ? "@workspace-extensions/git-tools" : null,
      hostProviderContracts: { gitInterop: ["upstreamStatus", "publishRepo"] },
      activeProviderContracts: {
        claudeCode: { methods: ["prepare", "publishRepo"] },
      },
    });
    vi.spyOn(host.processes, "isRunning").mockReturnValue(true);

    await expect(
      host
        .createServiceDefinition()
        .handler(panelCtx("panel-1"), "invokeProvider", ["claudeCode", "prepare", []])
    ).resolves.toBe("ok");
    await expect(
      host
        .createServiceDefinition()
        .handler(panelCtx("panel-1"), "invokeProvider", ["claudeCode", "publishRepo", []])
    ).resolves.toBe("ok");
    expect(extensionTransport.call).toHaveBeenNthCalledWith(
      1,
      "@workspace-extensions/git-tools",
      "extension.invokeProvider",
      [
        "claudeCode",
        "prepare",
        [],
        expect.objectContaining({ method: "providers.claudeCode.prepare" }),
      ]
    );
    expect(extensionTransport.call).toHaveBeenNthCalledWith(
      2,
      "@workspace-extensions/git-tools",
      "extension.invokeProvider",
      [
        "claudeCode",
        "publishRepo",
        [],
        expect.objectContaining({ method: "providers.claudeCode.publishRepo" }),
      ]
    );
  });

  it("represents command-style extension results as JSON null at the RPC boundary", async () => {
    const extensionTransport = { call: vi.fn(async () => undefined) };
    const { host } = makeHost({
      extensionTransport,
      resolveProviderExtensionName: (provider) =>
        provider === "claudeCode" ? "@workspace-extensions/git-tools" : null,
      activeProviderContracts: {
        claudeCode: { methods: ["prepare"] },
      },
    });
    vi.spyOn(host.processes, "isRunning").mockReturnValue(true);
    const service = host.createServiceDefinition();

    await expect(
      service.handler(panelCtx("panel-1"), "invoke", [
        "@workspace-extensions/git-tools",
        "command",
        [],
      ])
    ).resolves.toBeNull();
    await expect(
      service.handler(panelCtx("panel-1"), "invokeProvider", ["claudeCode", "prepare", []])
    ).resolves.toBeNull();
  });

  it("allows an unrelated extension to expose a public method with a provider-contract name", async () => {
    const extensionTransport = { call: vi.fn(async () => "ok") };
    const { host } = makeHost({
      extensionTransport,
      hostProviderContracts: { gitInterop: ["publishRepo"] },
      activeProviderContracts: {},
    });
    vi.spyOn(host.processes, "isRunning").mockReturnValue(true);

    await expect(
      host.invoke(panelCtx("panel-1"), "extensions/git-tools", "publishRepo", [])
    ).resolves.toBe("ok");
    expect(extensionTransport.call).toHaveBeenCalledWith(
      "@workspace-extensions/git-tools",
      "extension.invoke",
      ["publishRepo", [], expect.objectContaining({ method: "publishRepo" })]
    );
  });

  it("passes caller context id through extension invocations", async () => {
    const extensionTransport = {
      call: vi.fn(async () => "ok"),
    };
    const { host } = makeHost({
      extensionTransport,
      getContextIdForCaller: (callerId) => (callerId === "panel-1" ? "ctx-panel" : null),
    });
    vi.spyOn(host.processes, "isRunning").mockReturnValue(true);

    await expect(
      host.invoke(panelCtx("panel-1"), "@workspace-extensions/git-tools", "ping", [])
    ).resolves.toBe("ok");

    expect(extensionTransport.call).toHaveBeenCalledWith(
      "@workspace-extensions/git-tools",
      "extension.invoke",
      [
        "ping",
        [],
        expect.objectContaining({
          caller: expect.objectContaining({
            callerId: "panel-1",
            contextId: "ctx-panel",
          }),
          chainCaller: expect.objectContaining({
            callerId: "panel-1",
            contextId: "ctx-panel",
          }),
        }),
      ]
    );
  });

  it("threads inbound cancellation through the extension transport", async () => {
    const extensionTransport = { call: vi.fn(async () => "ok") };
    const { host, extensionNode } = makeHost({ extensionTransport });
    vi.spyOn(host.processes, "isRunning").mockReturnValue(true);
    const controller = new AbortController();

    await expect(
      host.invoke(
        { ...panelCtx("panel-1"), signal: controller.signal },
        extensionNode.name,
        "blame",
        []
      )
    ).resolves.toBe("ok");

    expect(extensionTransport.call).toHaveBeenCalledWith(
      extensionNode.name,
      "extension.invoke",
      ["blame", [], expect.objectContaining({ method: "blame" })],
      { signal: controller.signal }
    );
  });
});

describe("ExtensionHost reload approval", () => {
  it("requests a one-unit management approval for panel reloads", async () => {
    const { host, approvalQueue, extensionNode } = makeHost();
    const start = vi.spyOn(host.processes, "start").mockResolvedValue(undefined);

    await expect(host.reload(panelCtx("panel-1"), extensionNode.name)).resolves.toBeUndefined();

    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "unit-batch",
        callerId: "panel-1",
        callerKind: "panel",
        repoPath: "panels/test",
        effectiveVersion: "ev-test",
        trigger: "management",
        title: "Reload extension",
        units: [
          expect.objectContaining({
            unitKind: "extension",
            unitName: extensionNode.name,
            source: expect.objectContaining({ repo: extensionNode.relativePath, ref: "main" }),
            ev: "ev-current",
          }),
        ],
        configWrite: null,
      })
    );
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ name: extensionNode.name }));
  });

  it("does not prompt trusted shell reloads", async () => {
    const { host, approvalQueue, extensionNode } = makeHost();
    const start = vi.spyOn(host.processes, "start").mockResolvedValue(undefined);

    await expect(
      host.reload({ caller: createVerifiedCaller("shell-1", "shell") }, extensionNode.name)
    ).resolves.toBeUndefined();

    expect(approvalQueue.request).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ name: extensionNode.name }));
  });
});

const declare = (name: string, opts: { ref?: string } = {}) => [
  { source: name, ref: opts.ref ?? "main" },
];

describe("ExtensionHost reconcileDeclared", () => {
  it("computes meta-change approvals from committed workspace config", async () => {
    const readWorkspaceFileAtState = vi.fn(
      async () =>
        `systemEpoch: ${WORKSPACE_SYSTEM_EPOCH}\nextensions:\n  - source: extensions/git-tools\n`
    );
    const { host, extensionNode } = makeHost({
      installed: false,
      readWorkspaceFileAtState,
    });

    const approval = await host.unitChangeApprovalForCommit("state:next");

    expect(readWorkspaceFileAtState).toHaveBeenCalledWith("state:next", "meta/vibestudio.yml");
    expect(approval.units).toEqual([
      expect.objectContaining({
        unitKind: "extension",
        unitName: extensionNode.name,
        source: { kind: "workspace-repo", repo: extensionNode.relativePath, ref: "main" },
      }),
    ]);
  });

  it("builds and activates declared extensions after startup approval", async () => {
    const { host, approvalQueue, buildSystem, extensionNode } = makeHost({
      installed: false,
    });
    const start = vi.spyOn(host.processes, "start").mockResolvedValue(undefined);

    await host.reconcileDeclared(declare(extensionNode.name));
    await host.whenSettled();

    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "unit-batch",
        trigger: "startup",
        title: "Approve workspace extensions",
        units: [
          expect.objectContaining({
            unitKind: "extension",
            unitName: extensionNode.name,
            source: { kind: "workspace-repo", repo: extensionNode.relativePath, ref: "main" },
          }),
        ],
      })
    );
    expect(buildSystem.getBuild).toHaveBeenCalledWith(extensionNode.name, "main");
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ name: extensionNode.name }));
    expect(host.registry.get(extensionNode.name)).toMatchObject({
      activeBundleKey: "candidate-key",
      activeSourceHash: "state:test",
    });
  });

  it("builds approved on-invoke extensions without starting them until first use", async () => {
    const extensionTransport = { call: vi.fn(async () => "transport-result") };
    const { host, buildSystem, extensionNode } = makeHost({
      installed: false,
      activationEvents: ["onInvoke"],
      extensionTransport,
    });
    const start = vi.spyOn(host.processes, "start").mockResolvedValue(undefined);

    await host.reconcileDeclared(declare(extensionNode.name));
    await host.whenSettled();

    expect(buildSystem.getBuild).toHaveBeenCalledWith(extensionNode.name, "main");
    expect(start).not.toHaveBeenCalled();
    expect(host.registry.get(extensionNode.name)).toMatchObject({
      activeBundleKey: "candidate-key",
      status: "available",
    });

    await expect(
      host.invoke(panelCtx("panel-1"), extensionNode.name, "blame", [])
    ).resolves.toBe("transport-result");
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("keeps declared refs unchanged for managed workspace extension repos", async () => {
    const { host, approvalQueue, buildSystem, extensionNode } = makeHost({
      installed: false,
      gitDefaultBranch: "master",
    });
    vi.spyOn(host.processes, "start").mockResolvedValue(undefined);

    await host.reconcileDeclared(declare(extensionNode.name));
    await host.whenSettled();

    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "unit-batch",
        trigger: "startup",
        units: [
          expect.objectContaining({
            unitKind: "extension",
            unitName: extensionNode.name,
            source: { kind: "workspace-repo", repo: extensionNode.relativePath, ref: "main" },
          }),
        ],
      })
    );
    expect(buildSystem.getBuild).toHaveBeenCalledWith(extensionNode.name, "main");
    expect(host.registry.get(extensionNode.name)).toMatchObject({
      activeBundleKey: "candidate-key",
      source: { repo: extensionNode.relativePath, ref: "main" },
    });
  });

  it("does not block active extension invocation behind pending re-approval", async () => {
    const extensionTransport = {
      call: vi.fn(async (_name: string, _method: string, args: unknown[]) => {
        return `called:${String(args[0])}`;
      }),
    };
    const { host, approvalQueue, extensionNode } = makeHost({
      depEv: "ev-runtime-new",
      activeDepEv: "ev-runtime-old",
      extensionTransport,
    });
    approvalQueue.request.mockImplementation(() => new Promise(() => {}));
    vi.spyOn(host.processes, "isRunning").mockReturnValue(true);

    await host.reconcileDeclared(declare(extensionNode.name));
    const invoke = Promise.race([
      host.invoke(panelCtx("panel-1"), extensionNode.name, "blame", []),
      new Promise((resolve) => setTimeout(() => resolve("timed-out"), 25)),
    ]);

    await expect(invoke).resolves.toBe("called:blame");
    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "unit-batch",
        trigger: "startup",
        units: [
          expect.objectContaining({
            unitKind: "extension",
            unitName: extensionNode.name,
            source: { kind: "workspace-repo", repo: extensionNode.relativePath, ref: "main" },
          }),
        ],
      })
    );
    expect(host.registry.get(extensionNode.name)).toMatchObject({ activeBundleKey: "bundle-key" });
    expect(extensionTransport.call).toHaveBeenCalledWith(extensionNode.name, "extension.invoke", [
      "blame",
      [],
      expect.objectContaining({ extensionName: extensionNode.name }),
    ]);
  });

  it("does not hold target-local invocation behind unrelated reconciliation work", async () => {
    const extensionTransport = { call: vi.fn(async () => "called") };
    const { host, extensionNode } = makeHost({ extensionTransport });
    vi.spyOn(host.processes, "isRunning").mockReturnValue(true);
    vi.spyOn(host, "whenReconciled").mockImplementation(() => new Promise(() => {}));
    const declarationsStaged = vi.spyOn(host, "whenDeclarationsStaged");

    const result = await Promise.race([
      host.invoke(panelCtx("panel-1"), extensionNode.name, "blame", []),
      new Promise((resolve) => setTimeout(() => resolve("timed-out"), 25)),
    ]);

    expect(result).toBe("called");
    expect(declarationsStaged).toHaveBeenCalledTimes(1);
  });

  it("starts an already-approved declared extension without prompting", async () => {
    const { host, approvalQueue, buildSystem, extensionNode } = makeHost();
    const start = vi.spyOn(host.processes, "start").mockResolvedValue(undefined);

    await host.reconcileDeclared(declare(extensionNode.name));

    expect(approvalQueue.request).not.toHaveBeenCalled();
    expect(buildSystem.getBuild).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledWith(expect.objectContaining({ name: extensionNode.name }));
  });

  it("removes a registry entry that is no longer declared", async () => {
    const { host, extensionNode } = makeHost();
    const stop = vi.spyOn(host.processes, "stop").mockResolvedValue(undefined);

    await host.reconcileDeclared([]);

    expect(stop).toHaveBeenCalledWith(extensionNode.name);
    expect(host.registry.get(extensionNode.name)).toBeNull();
  });

  it("rebuilds an extension whose dependency EV changed", async () => {
    const { host, approvalQueue, buildSystem, extensionNode } = makeHost({
      activeEv: "ev-current",
      depEv: "ev-runtime-next",
      activeDepEv: "ev-runtime-old",
    });
    vi.spyOn(host.processes, "start").mockResolvedValue(undefined);

    await host.reconcileDeclared(declare(extensionNode.name));
    await host.whenSettled();

    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "unit-batch",
        trigger: "startup",
        units: [
          expect.objectContaining({
            unitKind: "extension",
            unitName: extensionNode.name,
            source: { kind: "workspace-repo", repo: extensionNode.relativePath, ref: "main" },
          }),
        ],
      })
    );
    expect(buildSystem.getBuild).toHaveBeenCalledWith(extensionNode.name, "main");
  });

  it("serializes concurrent rebuilds of the same extension", async () => {
    const { host, buildSystem, extensionNode } = makeHost();
    const releases: Array<() => void> = [];
    let activeStarts = 0;
    let maxActiveStarts = 0;
    const start = vi.spyOn(host.processes, "start").mockImplementation(async () => {
      activeStarts += 1;
      maxActiveStarts = Math.max(maxActiveStarts, activeStarts);
      await new Promise<void>((resolve) => releases.push(resolve));
      activeStarts -= 1;
    });
    const onPushBuild = buildSystem.onPushBuild.mock.calls[0]?.[0];
    expect(onPushBuild).toBeTypeOf("function");

    onPushBuild(extensionNode.relativePath, publicationEvent());
    onPushBuild(extensionNode.relativePath, publicationEvent());

    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
    expect(maxActiveStarts).toBe(1);
    releases.shift()?.();
    await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(2));
    expect(maxActiveStarts).toBe(1);
    releases.shift()?.();
    await vi.waitFor(() => expect(activeStarts).toBe(0));
  });

  it("retains an approved candidate build when its first activation fails", async () => {
    const { host, extensionNode } = makeHost({ installed: false });
    vi.spyOn(host.processes, "start").mockRejectedValue(new Error("ready timeout"));

    await host.reconcileDeclared(declare(extensionNode.name));
    await host.whenSettled();

    expect(host.registry.get(extensionNode.name)).toMatchObject({
      activeEv: "ev-candidate",
      activeBundleKey: "candidate-key",
      status: "error",
      lastError: "ready timeout",
    });
  });

  it("rebuilds a declared ref change and persists the trusted ref", async () => {
    const { host, approvalQueue, buildSystem, extensionNode } = makeHost();
    vi.spyOn(host.processes, "start").mockResolvedValue(undefined);

    await host.reconcileDeclared(declare(extensionNode.name, { ref: "feature" }));
    await host.whenSettled();

    expect(approvalQueue.request).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "unit-batch",
        trigger: "startup",
        units: [
          expect.objectContaining({
            unitKind: "extension",
            unitName: extensionNode.name,
            source: { kind: "workspace-repo", repo: extensionNode.relativePath, ref: "feature" },
          }),
        ],
      })
    );
    expect(buildSystem.getBuild).toHaveBeenCalledWith(extensionNode.name, "feature");
    expect(host.registry.get(extensionNode.name)).toMatchObject({
      activeBundleKey: "candidate-key",
      source: { repo: extensionNode.relativePath, ref: "feature" },
    });
  });
});

describe("ExtensionHost activation", () => {
  it("starts the approved active bundle instead of rebuilding the current ref", async () => {
    const { host, buildSystem, extensionNode } = makeHost();
    const start = vi.spyOn(host.processes, "start").mockResolvedValue(undefined);

    await host.activate(extensionNode.name);

    expect(buildSystem.getBuildByKey).toHaveBeenCalledWith("bundle-key");
    expect(buildSystem.getBuild).not.toHaveBeenCalled();
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        name: extensionNode.name,
        bundlePath: expect.stringContaining("bundle-key"),
      })
    );
  });

  it("registers contributed build providers through the activated extension transport", async () => {
    const registerBuildProvider = vi.fn();
    const extensionTransport = {
      call: vi.fn(async () => ({
        artifacts: [
          {
            path: "index.android.bundle",
            role: "primary",
            contentType: "application/javascript",
            encoding: "utf8",
            platform: "android",
            stream: { method: "buildArtifact", args: ["artifact-1"] },
          },
        ],
        metadata: { rnHostAbi: "rn-host-2" },
      })),
      streamCallTarget: vi.fn(async () => new Response("bundle")),
    };
    const { host, extensionNode } = makeHost({
      buildTargets: ["react-native"],
      registerBuildProvider,
      extensionTransport,
    });
    vi.spyOn(host.processes, "start").mockResolvedValue(undefined);

    await host.activate(extensionNode.name);

    expect(registerBuildProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        name: extensionNode.name,
        target: "react-native",
        activeEv: "ev-current",
        activeBuildKey: "bundle-key",
      })
    );
    const provider = registerBuildProvider.mock.calls[0]![0] as {
      build(input: unknown): Promise<unknown>;
      streamArtifact(artifact: unknown, input: unknown): Promise<Response>;
    };
    const output = await provider.build({ target: "react-native" });
    expect(output).toMatchObject({
      artifacts: [expect.objectContaining({ path: "index.android.bundle", platform: "android" })],
    });
    const response = await provider.streamArtifact(
      (output as { artifacts: unknown[] }).artifacts[0],
      { target: "react-native" }
    );
    await expect(response.text()).resolves.toBe("bundle");
    expect(extensionTransport.call).toHaveBeenCalledWith(extensionNode.name, "extension.invoke", [
      "build",
      [expect.objectContaining({ target: "react-native" })],
      expect.objectContaining({
        extensionName: extensionNode.name,
        method: "build",
        caller: expect.objectContaining({
          callerId: "server:build-system",
          callerKind: "server",
        }),
      }),
    ]);
    expect(extensionTransport.streamCallTarget).toHaveBeenCalledWith(
      extensionNode.name,
      "extension.invokeStream",
      "buildArtifact",
      ["artifact-1"],
      expect.objectContaining({
        extensionName: extensionNode.name,
        method: "buildArtifact",
        caller: expect.objectContaining({ callerId: "server:build-system", callerKind: "server" }),
      })
    );
  });

  it("unregisters stale build providers when an activated extension stops contributing a target", async () => {
    const registerBuildProvider = vi.fn();
    const unregisterBuildProvider = vi.fn();
    const { host, extensionNode } = makeHost({
      buildTargets: ["react-native"],
      registerBuildProvider,
      unregisterBuildProvider,
    });
    vi.spyOn(host.processes, "start").mockResolvedValue(undefined);

    await host.activate(extensionNode.name);
    expect(registerBuildProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        name: extensionNode.name,
        target: "react-native",
      })
    );

    delete extensionNode.manifest.extension.contributes;
    await host.activate(extensionNode.name);

    expect(unregisterBuildProvider).toHaveBeenCalledWith("react-native", extensionNode.name);
  });

  it("surfaces running extension inspector URLs in workspace unit status", () => {
    const { host, extensionNode } = makeHost();
    vi.spyOn(host.processes, "listRunning").mockReturnValue([
      {
        name: extensionNode.name,
        methods: ["blame"],
        hasFetch: true,
        health: null,
        inspectorUrl: "ws://127.0.0.1:9229/abcdef",
      },
    ]);

    expect(host.listWorkspaceUnits()[0]).toMatchObject({
      name: extensionNode.name,
      inspectorUrl: "ws://127.0.0.1:9229/abcdef",
      methods: ["blame"],
      hasFetch: true,
    });
  });

  it("invokes extension APIs over the connected WebSocket transport when available", async () => {
    let hostRef: ExtensionHost;
    const extensionTransport = {
      call: vi.fn(
        async (name: string, _method: string, args: [string, unknown[], { requestId: string }]) => {
          const invocation = args[2];
          expect(invocation.requestId).toEqual(expect.any(String));
          expect(invocation).not.toHaveProperty("causalParent");
          expect(hostRef.resolveActiveInvocation(name, invocation.requestId)).toEqual(
            expect.objectContaining({
              extensionName: name,
              method: "blame",
              causalParent: null,
            })
          );
          return "transport-result";
        }
      ),
    };
    const { host, extensionNode } = makeHost({ extensionTransport });
    hostRef = host;
    vi.spyOn(host.processes, "isRunning").mockReturnValue(true);

    await expect(
      host.invoke(panelCtx("panel-1"), extensionNode.name, "blame", ["README.md"])
    ).resolves.toBe("transport-result");

    expect(extensionTransport.call).toHaveBeenCalledWith(extensionNode.name, "extension.invoke", [
      "blame",
      ["README.md"],
      expect.objectContaining({
        extensionName: extensionNode.name,
        method: "blame",
        requestId: expect.any(String),
      }),
    ]);
    const invocation = extensionTransport.call.mock.calls[0]![2]![2] as { requestId: string };
    expect(host.resolveActiveInvocation(extensionNode.name, invocation.requestId)).toBeNull();
  });

  it("retains a verified causal parent in host-only active invocation state", async () => {
    const causalParent = {
      kind: "trajectory-invocation" as const,
      logId: "trajectory:channel:agent-1",
      head: "main",
      invocationId: "invocation:tool-1",
    };
    let hostRef: ExtensionHost;
    const extensionTransport = {
      call: vi.fn(
        async (name: string, _method: string, args: [string, unknown[], { requestId: string }]) => {
          const invocation = args[2];
          expect(invocation).not.toHaveProperty("causalParent");
          expect(hostRef.resolveActiveInvocation(name, invocation.requestId)).toEqual(
            expect.objectContaining({ causalParent })
          );
          return "transport-result";
        }
      ),
    };
    const { host, extensionNode } = makeHost({ extensionTransport });
    hostRef = host;
    vi.spyOn(host.processes, "isRunning").mockReturnValue(true);

    await expect(
      host.invoke({ ...doCtx(), causalParent }, extensionNode.name, "blame", ["README.md"])
    ).resolves.toBe("transport-result");

    const invocation = extensionTransport.call.mock.calls[0]![2]![2] as { requestId: string };
    expect(host.resolveActiveInvocation(extensionNode.name, invocation.requestId)).toBeNull();
  });

  it("accepts workspace-relative extension paths on invocation", async () => {
    const extensionTransport = { call: vi.fn(async () => "transport-result") };
    const { host, extensionNode } = makeHost({ extensionTransport });
    vi.spyOn(host.processes, "isRunning").mockReturnValue(true);

    await expect(
      host.invoke(panelCtx("panel-1"), `workspace/${extensionNode.relativePath}`, "blame", [])
    ).resolves.toBe("transport-result");

    expect(extensionTransport.call).toHaveBeenCalledWith(extensionNode.name, "extension.invoke", [
      "blame",
      [],
      expect.objectContaining({ extensionName: extensionNode.name }),
    ]);
  });

  it("accepts the shortName advertised by extensions.list on invocation", async () => {
    const extensionTransport = { call: vi.fn(async () => "transport-result") };
    const { host, extensionNode } = makeHost({ extensionTransport });
    vi.spyOn(host.processes, "isRunning").mockReturnValue(true);

    await expect(host.invoke(panelCtx("panel-1"), "git-tools", "blame", [])).resolves.toBe(
      "transport-result"
    );

    expect(extensionTransport.call).toHaveBeenCalledWith(extensionNode.name, "extension.invoke", [
      "blame",
      [],
      expect.objectContaining({ extensionName: extensionNode.name }),
    ]);
  });

  it("records extension invocation failures with stack context", async () => {
    const err = new Error("boom");
    (err as NodeJS.ErrnoException).code = "EBOOM";
    const extensionTransport = {
      call: vi.fn(async () => {
        throw err;
      }),
    };
    const { host, extensionNode } = makeHost({ extensionTransport });
    vi.spyOn(host.processes, "isRunning").mockReturnValue(true);

    await expect(host.invoke(panelCtx("panel-1"), extensionNode.name, "blame", [])).rejects.toThrow(
      `Extension ${extensionNode.name}.blame invocation failed: boom`
    );

    expect(host.listWorkspaceUnitLogs(extensionNode.name, { level: "error" })).toEqual([
      expect.objectContaining({
        level: "error",
        source: "console",
        message: expect.stringContaining("invocation failed: boom"),
        fields: expect.objectContaining({
          method: "blame",
          callerId: "panel-1",
          callerKind: "panel",
          code: "EBOOM",
          stack: expect.stringContaining("Caused by: Error: boom"),
        }),
      }),
    ]);
  });

  it("fails with ENOEXT and never prompts when invoking an undeclared extension", async () => {
    const extensionTransport = { call: vi.fn(async () => "transport-result") };
    const { host, approvalQueue, buildSystem, extensionNode } = makeHost({
      extensionTransport,
      installed: false,
    });
    vi.spyOn(host.processes, "isRunning").mockReturnValue(true);

    await expect(
      host.invoke(panelCtx("panel-1"), extensionNode.name, "blame", ["README.md"])
    ).rejects.toMatchObject({
      code: "ENOEXT",
      message: expect.stringContaining(
        `Workspace extension source exists at ${extensionNode.relativePath}`
      ),
    });

    await expect(
      host.invoke(panelCtx("panel-1"), extensionNode.name, "blame", ["README.md"])
    ).rejects.toThrow(`- source: ${extensionNode.relativePath}`);
    await expect(
      host.invoke(panelCtx("panel-1"), extensionNode.name, "blame", ["README.md"])
    ).rejects.toThrow("commit/push the meta repo");

    expect(approvalQueue.request).not.toHaveBeenCalled();
    expect(buildSystem.getBuild).not.toHaveBeenCalled();
    expect(extensionTransport.call).not.toHaveBeenCalled();
  });

  it("awaits the requested extension's approved first activation", async () => {
    const extensionTransport = { call: vi.fn(async () => "transport-result") };
    const { host, buildSystem, extensionNode } = makeHost({
      extensionTransport,
      installed: false,
    });
    const originalGetBuild = buildSystem.getBuild.getMockImplementation()!;
    let releaseBuild!: () => void;
    buildSystem.getBuild.mockImplementation(
      () =>
        new Promise((resolve, reject) => {
          releaseBuild = () => {
            void originalGetBuild().then(resolve, reject);
          };
        })
    );
    vi.spyOn(host.processes, "start").mockResolvedValue(undefined);
    vi.spyOn(host.processes, "isRunning").mockReturnValue(true);

    await host.reconcileDeclared(declare(extensionNode.name));
    await vi.waitFor(() => {
      expect(host.registry.get(extensionNode.name)).toMatchObject({ status: "building" });
    });

    const invocation = host.invoke(panelCtx("panel-1"), extensionNode.name, "blame", []);
    await Promise.resolve();
    expect(extensionTransport.call).not.toHaveBeenCalled();

    releaseBuild();
    await expect(invocation).resolves.toBe("transport-result");
    expect(extensionTransport.call).toHaveBeenCalledWith(
      extensionNode.name,
      "extension.invoke",
      ["blame", [], expect.objectContaining({ extensionName: extensionNode.name })]
    );
  });

  it("fails with ENOTREADY when an extension is not running", async () => {
    const { host, extensionNode } = makeHost();
    vi.spyOn(host.processes, "isRunning").mockReturnValue(false);

    await expect(
      host.invoke(panelCtx("panel-1"), extensionNode.name, "blame", [])
    ).rejects.toMatchObject({ code: "ENOTREADY" });
  });

  it("waits for a target-local crash restart before invoking", async () => {
    const extensionTransport = { call: vi.fn(async () => "transport-result") };
    const { host, extensionNode } = makeHost({ extensionTransport });
    const running = vi.spyOn(host.processes, "isRunning").mockReturnValue(false);
    const whenRunning = vi.spyOn(host.processes, "whenRunning").mockImplementation(async () => {
      running.mockReturnValue(true);
    });

    await expect(
      host.invoke(panelCtx("panel-1"), extensionNode.name, "blame", [])
    ).resolves.toBe("transport-result");
    expect(whenRunning).toHaveBeenCalledWith(extensionNode.name, undefined);
    expect(extensionTransport.call).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent first-use activation without restarting the ready child", async () => {
    const extensionTransport = { call: vi.fn(async () => "ok") };
    const { host, extensionNode } = makeHost({ extensionTransport });
    let running = false;
    vi.spyOn(host.processes, "isRunning").mockImplementation(() => running);
    vi.spyOn(host.processes, "whenRunning").mockImplementation(async () => {
      if (running) return;
      const error = new Error("Extension is not starting") as NodeJS.ErrnoException;
      error.code = "ENOTREADY";
      throw error;
    });
    const start = vi.spyOn(host.processes, "start").mockImplementation(async () => {
      await Promise.resolve();
      running = true;
    });

    await Promise.all([
      host.invoke(panelCtx("panel-1"), extensionNode.name, "blame", []),
      host.invoke(panelCtx("panel-2"), extensionNode.name, "blame", []),
    ]);

    expect(start).toHaveBeenCalledTimes(1);
    expect(extensionTransport.call).toHaveBeenCalledTimes(2);
  });

  it("streams extension fetch request bodies through chunk RPC", async () => {
    const requestBody = Buffer.from([0, 1, 2, 255]);
    const responseBody = Buffer.from([255, 2, 1, 0]);
    const capturedChunks: Buffer[] = [];
    let service: ReturnType<ExtensionHost["createServiceDefinition"]>;
    const extensionTransport = {
      call: vi.fn(async (_name: string, method: string, args: unknown[]) => {
        expect(method).toBe("extension.fetch");
        const request = args[0];
        const body = (request as { body?: { __stream?: true; id?: string } }).body;
        expect(body).toMatchObject({ __stream: true });
        expect(typeof body?.id).toBe("string");
        while (true) {
          const next = (await service.handler(
            { caller: createVerifiedCaller(extensionNode.name, "extension") } as any,
            "fetchRequestBodyChunk",
            [body!.id!]
          )) as { done: boolean; chunk?: { __bin: true; data: string } };
          if (next.done) break;
          expect(next.chunk).toMatchObject({ __bin: true });
          capturedChunks.push(Buffer.from(next.chunk!.data, "base64"));
        }
        return {
          status: 201,
          headers: { "content-type": "application/octet-stream" },
          body: { __bin: true, data: responseBody.toString("base64") },
        };
      }),
    };
    const { host, extensionNode } = makeHost({ extensionTransport });
    service = host.createServiceDefinition();
    const req = Readable.from([requestBody]) as any;
    req.method = "POST";
    req.url = "/_r/ext/%40workspace-extensions%2Fgit-tools/upload?x=1";
    req.headers = { "content-type": "application/octet-stream" };
    const res = {
      statusCode: 0,
      headers: undefined as Record<string, string> | undefined,
      body: undefined as Buffer | undefined,
      writeHead(status: number, headers: Record<string, string>) {
        this.statusCode = status;
        this.headers = headers;
      },
      end(body: Buffer | string) {
        this.body = Buffer.isBuffer(body) ? body : Buffer.from(body);
      },
    };

    await host.handleExtensionHttpRequest(
      req,
      res as any,
      extensionNode.name,
      "/upload",
      panelCtx("panel-1").caller
    );

    expect(extensionTransport.call).toHaveBeenCalledWith(extensionNode.name, "extension.fetch", [
      expect.objectContaining({
        body: expect.objectContaining({ __stream: true }),
      }),
      expect.objectContaining({ method: "fetch" }),
    ]);
    expect(Buffer.concat(capturedChunks)).toEqual(requestBody);
    expect(res.statusCode).toBe(201);
    expect(res.body).toEqual(responseBody);
  });

  it("streams extension fetch responses through chunk RPC", async () => {
    const responseChunks = [
      Buffer.from("hello "),
      Buffer.alloc(70 * 1024, 7),
      Buffer.from(" done"),
    ];
    const expectedBody = Buffer.concat(responseChunks);
    let closeCalled = false;
    const extensionTransport = {
      call: vi.fn(async (_name: string, method: string) => {
        if (method === "extension.fetch") {
          return {
            status: 200,
            headers: { "content-type": "application/octet-stream" },
            body: { __stream: true, id: "response-stream-1" },
          };
        }
        if (method === "extension.fetchResponseBodyChunk") {
          const chunk = responseChunks.shift();
          if (!chunk) return { done: true };
          return {
            done: false,
            chunk: { __bin: true, data: chunk.toString("base64") },
          };
        }
        if (method === "extension.fetchResponseBodyClose") {
          closeCalled = true;
          return null;
        }
        throw new Error(`Unexpected extension method: ${method}`);
      }),
    };
    const { host, extensionNode } = makeHost({ extensionTransport });
    const req = Readable.from([]) as any;
    req.method = "GET";
    req.url = "/_r/ext/%40workspace-extensions%2Fgit-tools/download";
    req.headers = {};
    class TestResponse extends Writable {
      statusCode = 0;
      headers: Record<string, string> | undefined;
      chunks: Buffer[] = [];
      writeHead(status: number, headers: Record<string, string>) {
        this.statusCode = status;
        this.headers = headers;
      }
      _write(
        chunk: Buffer | string,
        _encoding: BufferEncoding,
        callback: (error?: Error | null) => void
      ) {
        this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        callback();
      }
      body() {
        return Buffer.concat(this.chunks);
      }
    }
    const res = new TestResponse();

    await host.handleExtensionHttpRequest(
      req,
      res as any,
      extensionNode.name,
      "/download",
      panelCtx("panel-1").caller
    );

    expect(res.statusCode).toBe(200);
    expect(res.headers).toEqual({ "content-type": "application/octet-stream" });
    expect(res.body()).toEqual(expectedBody);
    expect(closeCalled).toBe(true);
    expect(extensionTransport.call).toHaveBeenCalledWith(
      extensionNode.name,
      "extension.fetchResponseBodyChunk",
      ["response-stream-1"]
    );
  });

  it("accepts extension event, health, and log requests over RPC", async () => {
    const recordUnitLog = vi.fn();
    const { host, extensionNode, eventService } = makeHost({ recordUnitLog });
    const service = host.createServiceDefinition();
    const extensionCtx = { caller: createVerifiedCaller(extensionNode.name, "extension") };

    const markReady = vi.spyOn(host.processes, "markReady");

    await service.handler(extensionCtx as any, "ready", [
      { methods: ["confirm"], providerMethods: {}, hasFetch: true },
    ]);
    await service.handler(extensionCtx as any, "emit", ["changed", { ok: true }]);
    await service.handler(extensionCtx as any, "health", ["degraded", { summary: "Waiting" }]);
    await service.handler(extensionCtx as any, "log", [
      "warn",
      "Something happened",
      { code: "TEST" },
    ]);

    expect(markReady).toHaveBeenCalledWith(extensionNode.name, {
      methods: ["confirm"],
      hasFetch: true,
    });
    expect(eventService.emit).toHaveBeenCalledWith(`extensions:${extensionNode.name}::changed`, {
      ok: true,
    });
    expect(eventService.emit).toHaveBeenCalledWith(
      "extensions:health",
      expect.objectContaining({
        name: extensionNode.name,
        health: expect.objectContaining({ state: "degraded", summary: "Waiting" }),
      })
    );
    expect(eventService.emit).toHaveBeenCalledWith(
      "workspace:unit-log",
      expect.objectContaining({
        unitName: extensionNode.name,
        level: "warn",
        message: "Something happened",
        fields: { code: "TEST" },
      })
    );
    expect(recordUnitLog).toHaveBeenCalledWith(
      expect.objectContaining({
        unitName: extensionNode.name,
        level: "warn",
        message: "Something happened",
      })
    );
  });

  it("rejects ready when runtime provider namespaces differ from the approved build", async () => {
    const { host, extensionNode } = makeHost({
      hostProviderContracts: { gitInterop: ["upstreamStatus"] },
      activeProviderContracts: {
        gitInterop: { methods: ["upstreamStatus"] },
      },
    });
    const service = host.createServiceDefinition();
    const extensionCtx = { caller: createVerifiedCaller(extensionNode.name, "extension") };

    await expect(
      service.handler(extensionCtx as any, "ready", [
        { methods: ["upstreamStatus"], providerMethods: {}, hasFetch: false },
      ])
    ).rejects.toMatchObject({ code: "EPROTO" });
  });

  it("allows server callers to invoke extension providers through the dispatcher", () => {
    const { host } = makeHost();
    expect(host.createServiceDefinition().authority.principals).toContain("host");
  });
});

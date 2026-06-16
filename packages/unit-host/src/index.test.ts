import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  UnitHost,
  UnitRegistry,
  UnitTrustResolver,
  authorizeUnitSourceChange,
  canonicalUnitBuildIdentity,
  collectTransitiveUnitDependencyEvs,
  createPendingUnitRegistryEntry,
  createUnitBatchEntryBase,
  createUnitBuildIdentity,
  findUnitGraphNode,
  normalizeUnitRepoPath,
  unitBuildIdentityFromRegistryEntry,
  unitChangeSessionGrantKey,
  unitWorkspaceLogRecord,
  unitWorkspaceStatus,
  type UnitDeclaration,
  type UnitBuildIdentity,
  type UnitGraphNode,
  type UnitRegistryEntryBase,
} from "./index.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-unit-registry-"));
  roots.push(root);
  return root;
}

function entry(overrides: Partial<UnitRegistryEntryBase> = {}): UnitRegistryEntryBase {
  return {
    unitKind: "extension",
    name: "@workspace-extensions/a",
    version: "1.0.0",
    source: { kind: "workspace-repo", repo: "extensions/a", ref: "main" },
    installedAt: 1,
    activeEv: null,
    activeSourceHash: null,
    activeBundleKey: null,
    activeDependencyEvs: {},
    activeExternalDeps: {},
    activeRuntimeDepsKey: null,
    status: "pending-approval",
    lastError: null,
    ...overrides,
  };
}

describe("UnitRegistry", () => {
  it("persists entries by unit kind under the shared units path", () => {
    const root = tempRoot();
    const registry = new UnitRegistry<UnitRegistryEntryBase>({
      statePath: root,
      unitKind: "extension",
    });
    registry.upsert(entry({ activeDependencyEvs: { "@workspace/runtime": "ev" } }));

    const reloaded = new UnitRegistry<UnitRegistryEntryBase>({
      statePath: root,
      unitKind: "extension",
    });

    expect(reloaded.get("@workspace-extensions/a")).toMatchObject({
      unitKind: "extension",
      activeDependencyEvs: { "@workspace/runtime": "ev" },
    });
    expect(
      JSON.parse(fs.readFileSync(path.join(root, "units", "extension", "registry.json"), "utf8")),
    ).toMatchObject({ unitKind: "extension" });
  });

  it("rejects storing an entry in the wrong unit registry", () => {
    const registry = new UnitRegistry<UnitRegistryEntryBase>({
      statePath: tempRoot(),
      unitKind: "extension",
    });

    expect(() => registry.upsert(entry({ unitKind: "app" }))).toThrow(/Cannot store app/);
  });

  it("builds pending registry entries with shared install-state defaults", () => {
    expect(createPendingUnitRegistryEntry({
      unitKind: "app",
      name: "@workspace-apps/shell",
      version: "1.0.0",
      sourceRepo: "workspace/apps/shell",
      ref: "main",
      building: true,
      installedAt: 10,
    })).toMatchObject({
      unitKind: "app",
      name: "@workspace-apps/shell",
      source: { kind: "workspace-repo", repo: "apps/shell", ref: "main" },
      installedAt: 10,
      activeEv: null,
      activeBundleKey: null,
      activeDependencyEvs: {},
      activeExternalDeps: {},
      activeRuntimeDepsKey: null,
      status: "building",
      lastError: null,
    });
  });

  it("builds shared batch approval entry bases with normalized source identity", () => {
    expect(createUnitBatchEntryBase({
      unitKind: "app",
      name: "@workspace-apps/shell",
      displayName: "Workspace Shell",
      version: "1.0.0",
      sourceRepo: "/workspace/apps/shell",
      ref: "main",
      effectiveVersion: "ev-app",
      dependencyEvs: { "@workspace/runtime": "ev-runtime" },
      externalDeps: { react: "19.0.0" },
    })).toEqual({
      unitKind: "app",
      unitName: "@workspace-apps/shell",
      displayName: "Workspace Shell",
      version: "1.0.0",
      source: { kind: "workspace-repo", repo: "apps/shell", ref: "main" },
      ev: "ev-app",
      dependencyEvs: { "@workspace/runtime": "ev-runtime" },
      externalDeps: { react: "19.0.0" },
    });
  });

  it("builds shared unit identities with normalized source and sorted capabilities", () => {
    expect(createUnitBuildIdentity({
      unitKind: "app",
      name: "@workspace-apps/shell",
      sourceRepo: "/workspace/apps/shell",
      ref: "main",
      effectiveVersion: "ev-app",
      dependencyEvs: { "@workspace/runtime": "ev-runtime" },
      externalDeps: { react: "19.0.0" },
      capabilities: ["z", "a"],
    })).toEqual({
      unitKind: "app",
      name: "@workspace-apps/shell",
      source: { kind: "workspace-repo", repo: "apps/shell", ref: "main" },
      effectiveVersion: "ev-app",
      dependencyEvs: { "@workspace/runtime": "ev-runtime" },
      externalDeps: { react: "19.0.0" },
      capabilities: ["a", "z"],
    });
  });

  it("builds registry-entry identities through the shared identity normalizer", () => {
    expect(unitBuildIdentityFromRegistryEntry(entry({
      unitKind: "app",
      name: "@workspace-apps/shell",
      source: { kind: "workspace-repo", repo: "/workspace/apps/shell", ref: "main" },
      activeEv: "ev-app",
      activeDependencyEvs: { "@workspace/runtime": "ev-runtime" },
      activeExternalDeps: { react: "19.0.0" },
    }), ["z", "a"])).toEqual({
      unitKind: "app",
      name: "@workspace-apps/shell",
      source: { kind: "workspace-repo", repo: "apps/shell", ref: "main" },
      effectiveVersion: "ev-app",
      dependencyEvs: { "@workspace/runtime": "ev-runtime" },
      externalDeps: { react: "19.0.0" },
      capabilities: ["a", "z"],
    });
  });

  it("collects transitive dependency effective versions once", () => {
    const nodes = [
      { name: "app", relativePath: "apps/app", internalDeps: ["pkg-a", "pkg-b"] },
      { name: "pkg-a", relativePath: "packages/a", internalDeps: ["pkg-c"] },
      { name: "pkg-b", relativePath: "packages/b", internalDeps: ["pkg-c", "missing"] },
      { name: "pkg-c", relativePath: "packages/c", internalDeps: [] },
    ];
    const lookups: string[] = [];

    expect(
      collectTransitiveUnitDependencyEvs(nodes, nodes[0]!, (name) => {
        lookups.push(name);
        return name === "missing" ? null : `ev-${name}`;
      }),
    ).toEqual({
      "pkg-a": "ev-pkg-a",
      "pkg-b": "ev-pkg-b",
      "pkg-c": "ev-pkg-c",
    });
    expect(lookups).toEqual(["pkg-a", "pkg-c", "pkg-b", "missing"]);
  });

  it("finds unit graph nodes by package name or normalized repo path", () => {
    const descriptor = {
      buildKind: "app" as const,
      approvalFraming: { unitLabel: "app" },
    };
    const nodes = [
      { name: "@workspace-apps/shell", kind: "app", relativePath: "apps/shell" },
      { name: "@workspace-extensions/rn", kind: "extension", relativePath: "extensions/rn" },
    ];

    expect(findUnitGraphNode(nodes, descriptor, "@workspace-apps/shell")).toBe(nodes[0]);
    expect(findUnitGraphNode(nodes, descriptor, "workspace/apps/shell")).toBe(nodes[0]);
    expect(() => findUnitGraphNode(nodes, descriptor, "@workspace-extensions/rn")).toThrow(/Unknown app unit/);
  });
});

describe("workspace unit summaries", () => {
  it("maps registry entries to shared workspace status rows", () => {
    expect(unitWorkspaceStatus("extension", entry({
      activeEv: "ev",
      activeBundleKey: "bundle",
      activeRuntimeDepsKey: "runtime",
      status: "running",
    }), {
      source: "extensions/display",
      displayName: "Display Name",
    })).toEqual({
      name: "@workspace-extensions/a",
      kind: "extension",
      source: "extensions/display",
      displayName: "Display Name",
      status: "running",
      version: "1.0.0",
      ev: "ev",
      activeEv: "ev",
      activeBundleKey: "bundle",
      activeRuntimeDepsKey: "runtime",
      lastError: null,
    });
  });

  it("maps registry entries to shared fallback log rows", () => {
    expect(unitWorkspaceLogRecord("app", "workspace-1", entry({
      unitKind: "app",
      name: "@workspace-apps/shell",
      status: "error",
      lastError: "boom",
    }))).toEqual({
      workspaceId: "workspace-1",
      unitName: "@workspace-apps/shell",
      kind: "app",
      timestamp: 1,
      level: "error",
      message: "boom",
    });
  });
});

describe("UnitTrustResolver", () => {
  function identity(overrides: Partial<UnitBuildIdentity<"extension">> = {}): UnitBuildIdentity<"extension"> {
    return {
      unitKind: "extension",
      name: "@workspace-extensions/a",
      source: { kind: "workspace-repo", repo: "extensions/a", ref: "main" },
      effectiveVersion: "ev",
      dependencyEvs: { "@workspace/runtime": "ev-runtime" },
      externalDeps: { leftpad: "1.0.0" },
      ...overrides,
    };
  }

  it("canonicalizes build identities with sorted object keys", () => {
    const first = identity({
      dependencyEvs: { b: "2", a: "1" },
      externalDeps: { z: "26", c: "3" },
    });
    const second = identity({
      externalDeps: { c: "3", z: "26" },
      dependencyEvs: { a: "1", b: "2" },
    });

    expect(canonicalUnitBuildIdentity(first)).toBe(canonicalUnitBuildIdentity(second));
  });

  it("returns user-approved only for an active registry entry matching the candidate identity", () => {
    const resolver = new UnitTrustResolver<UnitRegistryEntryBase>();
    const candidate = identity();

    expect(resolver.resolve({
      identity: candidate,
      entry: entry({
        activeBundleKey: "bundle",
        activeEv: "ev",
        activeDependencyEvs: { "@workspace/runtime": "ev-runtime" },
        activeExternalDeps: { leftpad: "1.0.0" },
        status: "running",
      }),
    }).decision).toBe("user-approved");
    expect(resolver.resolve({
      identity: candidate,
      entry: entry({
        activeBundleKey: "bundle",
        activeEv: "ev-old",
        activeDependencyEvs: { "@workspace/runtime": "ev-runtime" },
        activeExternalDeps: { leftpad: "1.0.0" },
        status: "running",
      }),
    }).decision).toBe("needs-approval");
    expect(resolver.resolve({
      identity: candidate,
      entry: entry({
        activeBundleKey: null,
        activeEv: "ev",
        activeDependencyEvs: { "@workspace/runtime": "ev-runtime" },
        activeExternalDeps: { leftpad: "1.0.0" },
        status: "pending-approval",
      }),
    }).decision).toBe("needs-approval");
  });

  it("does not reuse approval when the candidate identity is incomplete", () => {
    const resolver = new UnitTrustResolver<UnitRegistryEntryBase>();
    const candidate = identity({ effectiveVersion: null });

    expect(resolver.resolve({
      identity: candidate,
      entry: entry({
        activeBundleKey: "bundle",
        activeEv: "ev",
        activeDependencyEvs: { "@workspace/runtime": "ev-runtime" },
        activeExternalDeps: { leftpad: "1.0.0" },
        status: "running",
      }),
    }).decision).toBe("needs-approval");
  });

  it("does not reuse approval across capability identity drift", () => {
    const resolver = new UnitTrustResolver<UnitRegistryEntryBase>({
      entryIdentity: (approved) => unitBuildIdentityFromRegistryEntry(approved),
    });

    expect(resolver.resolve({
      identity: identity({ capabilities: ["notifications"] }),
      entry: entry({
        activeBundleKey: "bundle",
        activeEv: "ev",
        activeDependencyEvs: { "@workspace/runtime": "ev-runtime" },
        activeExternalDeps: { leftpad: "1.0.0" },
        status: "running",
      }),
    }).decision).toBe("needs-approval");
  });

  it("returns preapproved for exact preapproved identity keys", () => {
    const resolver = new UnitTrustResolver<UnitRegistryEntryBase>();
    const candidate = identity();

    expect(resolver.resolve({
      identity: candidate,
      entry: null,
      preapprovedIdentityKeys: new Set([canonicalUnitBuildIdentity(candidate)]),
    }).decision).toBe("preapproved");
    expect(resolver.resolve({
      identity: identity({ effectiveVersion: "ev-next" }),
      entry: null,
      preapprovedIdentityKeys: new Set([canonicalUnitBuildIdentity(candidate)]),
    }).decision).toBe("needs-approval");
  });
});

describe("authorizeUnitSourceChange", () => {
  const descriptor = {
    kind: "extension",
    sourceRoot: "extensions",
    buildKind: "extension",
    approvalFraming: {
      serviceName: "extensions",
      unitLabel: "extension",
      unitLabelPlural: "extensions",
      nativeCode: true,
    },
    seedTrustEligible: true,
  } as const;
  const node = {
    name: "@workspace-extensions/a",
    relativePath: "extensions/a",
  };
  const activeEntry = entry({
    activeBundleKey: "bundle",
    activeEv: "ev",
    status: "running",
  });

  function makeGrantStore() {
    const active = new Set<string>();
    return {
      active,
      hasActive: (key: string) => active.has(key),
      grant: (key: string) => {
        active.add(key);
      },
    };
  }

  it("normalizes repo paths before ownership lookup", async () => {
    const grantStore = makeGrantStore();
    const seen: string[] = [];

    await authorizeUnitSourceChange({
      descriptor,
      grantStore,
      grantTtlMs: 1000,
      findInstalledByRepo: (repoPath) => {
        seen.push(repoPath);
        return null;
      },
      requestApproval: async () => "once",
    }, {
      caller: { runtime: { id: "panel:one", kind: "panel" } },
      repoPath: "workspace/extensions/a",
      branch: "main",
      commit: "abc",
    });

    expect(seen).toEqual(["extensions/a"]);
    expect(normalizeUnitRepoPath("/workspace/extensions/a/")).toBe("extensions/a");
  });

  it("denies unsupported runtime callers before prompting", async () => {
    const grantStore = makeGrantStore();
    const prompted: string[] = [];

    const result = await authorizeUnitSourceChange({
      descriptor,
      grantStore,
      grantTtlMs: 1000,
      findInstalledByRepo: () => ({ entry: activeEntry, node }),
      requestApproval: async () => {
        prompted.push("prompted");
        return "once";
      },
    }, {
      caller: { runtime: { id: "extension:one", kind: "extension" } },
      repoPath: "extensions/a",
      branch: "main",
      commit: "abc",
    });

    expect(result).toEqual({
      allowed: false,
      reason: "Extension source changes from extension callers are not supported",
    });
    expect(prompted).toEqual([]);
  });

  it("records session grants after approval", async () => {
    const grantStore = makeGrantStore();
    const promptedBranches: string[] = [];
    const request = {
      caller: {
        runtime: { id: "panel:one", kind: "panel" },
        code: {
          callerKind: "panel",
          repoPath: "panels/main",
          effectiveVersion: "ev-panel",
        },
      },
      repoPath: "extensions/a",
      branch: "refs/heads/main",
      commit: "abc",
    };

    await expect(authorizeUnitSourceChange({
      descriptor,
      grantStore,
      grantTtlMs: 1000,
      findInstalledByRepo: () => ({ entry: activeEntry, node }),
      requestApproval: async ({ request: sourceChange }) => {
        promptedBranches.push(sourceChange.branch);
        return "session";
      },
    }, request)).resolves.toEqual({ allowed: true });

    await expect(authorizeUnitSourceChange({
      descriptor,
      grantStore,
      grantTtlMs: 1000,
      findInstalledByRepo: () => ({ entry: activeEntry, node }),
      requestApproval: async () => {
        promptedBranches.push("unexpected");
        return "session";
      },
    }, { ...request, branch: "main" })).resolves.toEqual({ allowed: true });

    expect(grantStore.active.has(
      unitChangeSessionGrantKey("panel:one", "@workspace-extensions/a", "extensions/a", "main"),
    )).toBe(true);
    expect(promptedBranches).toEqual(["main"]);
  });

  it("gates source changes to the installed unit ref instead of hardcoded main branches", async () => {
    const grantStore = makeGrantStore();
    const prompted: string[] = [];
    const featureEntry = entry({
      source: { kind: "workspace-repo", repo: "extensions/a", ref: "feature" },
      activeBundleKey: "bundle",
      status: "running",
    });
    const baseRequest = {
      caller: {
        runtime: { id: "panel:one", kind: "panel" },
        code: {
          callerKind: "panel",
          repoPath: "panels/main",
          effectiveVersion: "ev-panel",
        },
      },
      repoPath: "extensions/a",
      commit: "abc",
    };

    await expect(authorizeUnitSourceChange({
      descriptor,
      grantStore,
      grantTtlMs: 1000,
      findInstalledByRepo: () => ({ entry: featureEntry, node }),
      requestApproval: async () => {
        prompted.push("prompted");
        return "once";
      },
    }, { ...baseRequest, branch: "main" })).resolves.toEqual({ allowed: true });

    await expect(authorizeUnitSourceChange({
      descriptor,
      grantStore,
      grantTtlMs: 1000,
      findInstalledByRepo: () => ({ entry: featureEntry, node }),
      requestApproval: async () => {
        prompted.push("prompted");
        return "once";
      },
    }, { ...baseRequest, branch: "refs/heads/feature" })).resolves.toEqual({ allowed: true });

    expect(prompted).toEqual(["prompted"]);
  });
});

describe("UnitHost", () => {
  interface TestNode extends UnitGraphNode {
    version: string;
  }
  type TestDecl = UnitDeclaration;
  type TestApproval = { name: string; ref: string };

  function makeHarness(opts: {
    active?: boolean;
    extraNode?: TestNode;
  } = {}) {
    const root = tempRoot();
    const registry = new UnitRegistry<UnitRegistryEntryBase>({
      statePath: root,
      unitKind: "extension",
    });
    if (opts.active) {
      registry.upsert(entry({
        activeBundleKey: "bundle",
        activeEv: "ev",
        status: "running",
      }));
    }
    const node: TestNode = {
      name: "@workspace-extensions/a",
      relativePath: "extensions/a",
      version: "1.0.0",
    };
    const nodes = [node, ...(opts.extraNode ? [opts.extraNode] : [])];
    const applied: string[] = [];
    const removed: string[] = [];
    const prompted: TestApproval[][] = [];
    const denied: string[] = [];
    const host = new UnitHost<UnitRegistryEntryBase, TestDecl, TestNode, TestApproval>({
      descriptor: {
        kind: "extension",
        sourceRoot: "extensions",
        buildKind: "extension",
        approvalFraming: {
          serviceName: "extensions",
          unitLabel: "extension",
          unitLabelPlural: "extensions",
          nativeCode: true,
        },
        seedTrustEligible: true,
      },
      registry,
      resolveNode: (source) => {
        const match = nodes.find(
          (candidate) => source === candidate.relativePath || source === candidate.name,
        );
        if (!match) throw new Error("missing");
        return match;
      },
      candidateIdentity: (n, decl) => ({
        unitKind: "extension",
        name: n.name,
        source: { kind: "workspace-repo", repo: n.relativePath, ref: decl.ref },
        effectiveVersion: "ev",
        dependencyEvs: {},
        externalDeps: {},
      }),
      trustResolver: undefined,
      makePendingEntry: (n, decl, building) => entry({
        name: n.name,
        source: { kind: "workspace-repo", repo: n.relativePath, ref: decl.ref },
        status: building ? "building" : "pending-approval",
      }),
      applyTrusted: async (n) => {
        applied.push(n.name);
      },
      removeUndeclared: async (candidate) => {
        removed.push(candidate.name);
      },
      emitRemoved: () => undefined,
      notifyUnresolved: () => undefined,
      approvalEntry: (n, decl) => ({ name: n.name, ref: decl.ref }),
      requestApproval: async (entries) => {
        prompted.push(entries);
        return "once";
      },
      onApprovalDenied: (items) => {
        denied.push(...items.map((item) => item.node.name));
      },
      onBackgroundError: (error) => {
        throw error;
      },
    });
    return { host, registry, applied, removed, prompted, denied, node };
  }

  it("applies declared units after approval", async () => {
    const { host, applied, prompted, node } = makeHarness();

    await host.reconcileDeclared([{ source: "extensions/a", ref: "main" }]);
    await host.whenSettled();

    expect(applied).toEqual(["@workspace-extensions/a"]);
    expect(prompted).toEqual([[{ name: node.name, ref: "main" }]]);
  });

  it("applies preapproved declarations without prompting again", async () => {
    const { host, applied, prompted, node } = makeHarness();
    const approval = host.approvalForDeclarations([{ source: "extensions/a", ref: "main" }]);

    host.acceptPreapprovedTrust(approval.identityKeys);
    await host.reconcileDeclared([{ source: "extensions/a", ref: "main" }]);
    await host.whenSettled();

    expect(applied).toEqual([node.name]);
    expect(prompted).toEqual([]);
  });

  it("honors removeUndeclared while applying trusted declarations", async () => {
    const { host, registry, removed, node } = makeHarness({ active: true });
    registry.upsert(entry({
      name: "@workspace-extensions/old",
      source: { kind: "workspace-repo", repo: "extensions/old", ref: "main" },
      activeBundleKey: "old-bundle",
      status: "running",
    }));

    await host.reconcileDeclared(
      [{ source: node.relativePath, ref: "main" }],
      { removeUndeclared: true },
    );
    expect(removed).toEqual(["@workspace-extensions/old"]);
    expect(registry.get("@workspace-extensions/old")).toBeNull();
  });

  it("collects approval entries for untrusted declarations", () => {
    const { host, node } = makeHarness();

    expect(host.approvalForDeclarations([
      { source: node.relativePath, ref: "main" },
      { source: "extensions/missing", ref: "main" },
    ])).toEqual({
      entries: [{ name: node.name, ref: "main" }],
      identityKeys: [expect.any(String)],
    });
  });

  it("does not collect approval entries for already approved declarations", () => {
    const { host, node } = makeHarness({ active: true });

    expect(host.approvalForDeclarations([
      { source: node.relativePath, ref: "main" },
    ])).toEqual({ entries: [], identityKeys: [] });
  });

  it("resolves declaration trust through the host identity pipeline", () => {
    const { host, node } = makeHarness({ active: true });

    expect(host.trustForDeclaration(node, {
      source: node.relativePath,
      ref: "main",
    })).toMatchObject({ decision: "user-approved" });
    expect(host.trustForDeclaration(node, {
      source: node.relativePath,
      ref: "feature",
    })).toMatchObject({ decision: "needs-approval" });
  });

  it("applies runtime declarations through the shared trust/build/activate flow", async () => {
    const { host, registry, node } = makeHarness({ active: true });
    const built: string[] = [];
    const activated: string[] = [];

    await host.applyRuntimeDeclaration({
      node,
      decl: { source: node.relativePath, ref: "main" },
      needsBuildRefresh: () => false,
      buildAndActivate: async () => {
        built.push("built");
      },
      activateCurrent: async (entryValue) => {
        activated.push(entryValue.name);
      },
    });
    expect(built).toEqual([]);
    expect(activated).toEqual([node.name]);

    await host.applyRuntimeDeclaration({
      node,
      decl: { source: node.relativePath, ref: "main" },
      needsBuildRefresh: () => true,
      buildAndActivate: async (n) => {
        built.push(n.name);
      },
      activateCurrent: async () => {
        activated.push("stale");
      },
    });
    expect(built).toEqual([node.name]);
    expect(activated).toEqual([node.name]);

    registry.delete(node.name);
    await host.applyRuntimeDeclaration({
      node,
      decl: { source: node.relativePath, ref: "main" },
      needsBuildRefresh: () => false,
      buildAndActivate: async (n) => {
        built.push(`missing:${n.name}`);
      },
      activateCurrent: async () => {
        activated.push("missing");
      },
    });
    expect(registry.get(node.name)).toMatchObject({ status: "building" });
    expect(built).toEqual([node.name, `missing:${node.name}`]);
  });

  it("marks runtime declaration failures as registry errors", async () => {
    const { host, registry, node } = makeHarness({ active: true });
    const errors: string[] = [];

    await host.applyRuntimeDeclaration({
      node,
      decl: { source: node.relativePath, ref: "main" },
      needsBuildRefresh: () => false,
      buildAndActivate: async () => undefined,
      activateCurrent: async () => {
        throw new Error("activation failed");
      },
      onError: (_node, _decl, message) => errors.push(message),
    });

    expect(registry.get(node.name)).toMatchObject({
      status: "error",
      lastError: "activation failed",
    });
    expect(errors).toEqual(["activation failed"]);
  });

  it("compares active build state with shared source, EV, dependency, and runtime keys", () => {
    const { host } = makeHarness({ active: true });
    const active = entry({
      activeEv: "ev",
      activeDependencyEvs: { dep: "ev-dep" },
      activeExternalDeps: { leftpad: "1.0.0" },
      activeRuntimeDepsKey: "runtime-key",
    });

    expect(host.activeSourceMatches(active, "workspace/extensions/a", "main")).toBe(true);
    expect(host.needsBuildRefresh(active, {
      sourceRepo: "extensions/a",
      ref: "main",
      effectiveVersion: "ev",
      dependencyEvs: { dep: "ev-dep" },
      externalDeps: { leftpad: "1.0.0" },
      runtimeDepsKey: "runtime-key",
    })).toBe(false);
    expect(host.needsBuildRefresh(active, {
      sourceRepo: "extensions/a",
      ref: "feature",
      effectiveVersion: "ev",
      dependencyEvs: { dep: "ev-dep" },
      externalDeps: { leftpad: "1.0.0" },
      runtimeDepsKey: "runtime-key",
    })).toBe(true);
    expect(host.needsBuildRefresh(active, {
      sourceRepo: "extensions/a",
      ref: "main",
      effectiveVersion: "ev-next",
      dependencyEvs: { dep: "ev-dep" },
      externalDeps: { leftpad: "1.0.0" },
      runtimeDepsKey: "runtime-key",
    })).toBe(true);
    expect(host.needsBuildRefresh(active, {
      sourceRepo: "extensions/a",
      ref: "main",
      effectiveVersion: "ev",
      dependencyEvs: { dep: "ev-next" },
      externalDeps: { leftpad: "1.0.0" },
      runtimeDepsKey: "runtime-key",
    })).toBe(true);
    expect(host.needsBuildRefresh(active, {
      sourceRepo: "extensions/a",
      ref: "main",
      effectiveVersion: "ev",
      dependencyEvs: { dep: "ev-dep" },
      externalDeps: { leftpad: "2.0.0" },
      runtimeDepsKey: "runtime-key",
    })).toBe(true);
    expect(host.needsBuildRefresh(active, {
      sourceRepo: "extensions/a",
      ref: "main",
      effectiveVersion: "ev",
      dependencyEvs: { dep: "ev-dep" },
      externalDeps: { leftpad: "1.0.0" },
      runtimeDepsKey: "runtime-next",
    })).toBe(true);
  });

  it("finds installed units by normalized repo path", () => {
    const { host, node } = makeHarness({ active: true });

    expect(host.findInstalledByRepo("/workspace/extensions/a")).toMatchObject({
      entry: expect.objectContaining({ name: node.name }),
      node,
    });
    expect(host.findInstalledByRepo("extensions/a/src/index.ts")).toMatchObject({
      entry: expect.objectContaining({ name: node.name }),
      node,
    });
    expect(host.findInstalledByRepo("apps/shell")).toBeNull();
  });

  it("removes registry entries that are no longer declared", async () => {
    const { host, registry, removed } = makeHarness({ active: true });

    await host.reconcileDeclared([]);

    expect(removed).toEqual(["@workspace-extensions/a"]);
    expect(registry.get("@workspace-extensions/a")).toBeNull();
  });

  it("can reconcile a selected declaration without removing other registry entries", async () => {
    const extraNode = {
      name: "@workspace-extensions/b",
      relativePath: "extensions/b",
      version: "1.0.0",
    };
    const { host, registry, removed } = makeHarness({ active: true, extraNode });
    registry.upsert(entry({
      name: extraNode.name,
      source: { kind: "workspace-repo", repo: extraNode.relativePath, ref: "main" },
      activeBundleKey: "bundle-b",
      activeEv: "ev",
      status: "running",
    }));

    await host.reconcileDeclared(
      [{ source: "extensions/a", ref: "main" }],
      { removeUndeclared: false },
    );
    await host.whenSettled();

    expect(removed).toEqual([]);
    expect(registry.get("@workspace-extensions/a")).toMatchObject({ status: "running" });
    expect(registry.get("@workspace-extensions/b")).toMatchObject({ status: "running" });
  });
});

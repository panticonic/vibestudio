import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  UnitHost,
  UnitRegistry,
  UnitTrustResolver,
  FileUnitIdentityApprovalStore,
  canonicalUnitBuildIdentity,
  collectTransitiveUnitDependencyEvs,
  createPendingUnitRegistryEntry,
  createReviewedUnitBase,
  createUnitBuildIdentity,
  findUnitGraphNode,
  unitBuildIdentityFromRegistryEntry,
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-unit-registry-"));
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
  it("publishes committed registry transitions to target-local waiters", () => {
    const registry = new UnitRegistry<UnitRegistryEntryBase>({
      statePath: tempRoot(),
      unitKind: "extension",
    });
    const changes: Array<{ name: string; current: UnitRegistryEntryBase | null }> = [];
    const unsubscribe = registry.subscribe(({ name, current }) => changes.push({ name, current }));

    registry.upsert(entry());
    registry.patch(entry().name, { status: "available", activeBundleKey: "b".repeat(64) });
    unsubscribe();
    registry.delete(entry().name);

    expect(changes).toEqual([
      { name: entry().name, current: expect.objectContaining({ status: "pending-approval" }) },
      {
        name: entry().name,
        current: expect.objectContaining({ status: "available", activeBundleKey: "b".repeat(64) }),
      },
    ]);
  });

  it("does not publish an owner record when exact execution reservation fails", () => {
    const root = tempRoot();
    const registry = new UnitRegistry<UnitRegistryEntryBase>({
      statePath: root,
      unitKind: "extension",
      publicationPort: {
        reserve() {
          throw new Error("execution identity mismatch");
        },
        finalize() {},
      },
      publicationKeyForEntry: (value) => value.activeBundleKey ?? "",
      publicationForEntry: (value) => ({
        owner: "extension-generation",
        ownerId: value.name,
        artifacts: [{ buildKey: value.activeBundleKey!, executionDigest: "e".repeat(64) }],
      }),
    });

    expect(() => registry.upsert(entry({ activeBundleKey: "b".repeat(64) }))).toThrow(
      /identity mismatch/
    );
    expect(registry.list()).toEqual([]);
  });

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
      JSON.parse(fs.readFileSync(path.join(root, "units", "extension", "registry.json"), "utf8"))
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
    expect(
      createPendingUnitRegistryEntry({
        unitKind: "app",
        name: "@workspace-apps/shell",
        version: "1.0.0",
        sourceRepo: "workspace/apps/shell",
        ref: "main",
        building: true,
        installedAt: 10,
      })
    ).toMatchObject({
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
    expect(
      createReviewedUnitBase({
        unitKind: "app",
        name: "@workspace-apps/shell",
        displayName: "Workspace Shell",
        icon: "🖥️",
        version: "1.0.0",
        sourceRepo: "/workspace/apps/shell",
        ref: "main",
        effectiveVersion: "ev-app",
        dependencyEvs: { "@workspace/runtime": "ev-runtime" },
        externalDeps: { react: "19.0.0" },
      })
    ).toEqual({
      unitKind: "app",
      unitName: "@workspace-apps/shell",
      displayName: "Workspace Shell",
      icon: "🖥️",
      version: "1.0.0",
      source: { kind: "workspace-repo", repo: "apps/shell", ref: "main" },
      ev: "ev-app",
      dependencyEvs: { "@workspace/runtime": "ev-runtime" },
      externalDeps: { react: "19.0.0" },
    });
  });

  it("builds shared unit identities with normalized source and sorted capabilities", () => {
    expect(
      createUnitBuildIdentity({
        unitKind: "app",
        name: "@workspace-apps/shell",
        sourceRepo: "/workspace/apps/shell",
        ref: "main",
        effectiveVersion: "ev-app",
        dependencyEvs: { "@workspace/runtime": "ev-runtime" },
        externalDeps: { react: "19.0.0" },
        capabilities: ["z", "a"],
      })
    ).toEqual({
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
    expect(
      unitBuildIdentityFromRegistryEntry(
        entry({
          unitKind: "app",
          name: "@workspace-apps/shell",
          source: { kind: "workspace-repo", repo: "/workspace/apps/shell", ref: "main" },
          activeEv: "ev-app",
          activeDependencyEvs: { "@workspace/runtime": "ev-runtime" },
          activeExternalDeps: { react: "19.0.0" },
        }),
        ["z", "a"]
      )
    ).toEqual({
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
      })
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
    expect(() => findUnitGraphNode(nodes, descriptor, "@workspace-extensions/rn")).toThrow(
      /Unknown app unit/
    );
  });
});

describe("FileUnitIdentityApprovalStore", () => {
  it("persists exact reviewed identities independently of activation", () => {
    const root = tempRoot();
    const first = new FileUnitIdentityApprovalStore({ statePath: root, unitKind: "app" });
    first.approveMany(["identity:b", "identity:a"]);

    const reloaded = new FileUnitIdentityApprovalStore({ statePath: root, unitKind: "app" });
    expect(reloaded.has("identity:a")).toBe(true);
    expect(reloaded.has("identity:b")).toBe(true);
    expect(reloaded.has("identity:other")).toBe(false);
  });

  it("rolls back only prepared identities and preserves later approvals", () => {
    const root = tempRoot();
    const store = new FileUnitIdentityApprovalStore({ statePath: root, unitKind: "app" });
    const transaction = store.prepareApproveMany(["identity:prepared"]);

    store.approveMany(["identity:later"]);
    transaction.failed(new Error("protected refs rejected the publication"));

    expect(store.has("identity:prepared")).toBe(false);
    expect(store.has("identity:later")).toBe(true);
    const reloaded = new FileUnitIdentityApprovalStore({ statePath: root, unitKind: "app" });
    expect(reloaded.has("identity:prepared")).toBe(false);
    expect(reloaded.has("identity:later")).toBe(true);
  });

  it("preserves a later approval of the same identity when an older preparation fails", () => {
    const root = tempRoot();
    const store = new FileUnitIdentityApprovalStore({ statePath: root, unitKind: "extension" });
    const transaction = store.prepareApproveMany(["identity:shared"]);

    store.approveMany(["identity:shared"]);
    transaction.failed(new Error("protected refs rejected the publication"));

    expect(store.has("identity:shared")).toBe(true);
    expect(
      new FileUnitIdentityApprovalStore({ statePath: root, unitKind: "extension" }).has(
        "identity:shared"
      )
    ).toBe(true);
  });

  it("fails closed on unknown persisted schemas", () => {
    const root = tempRoot();
    const file = path.join(root, "units", "extension", "approvals.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify({ schemaVersion: 2, unitKind: "extension", identityKeys: [] })
    );

    expect(
      () => new FileUnitIdentityApprovalStore({ statePath: root, unitKind: "extension" })
    ).toThrow(/Unsupported or invalid extension approval-store schema/);
  });
});

describe("workspace unit summaries", () => {
  it("maps registry entries to shared workspace status rows", () => {
    expect(
      unitWorkspaceStatus(
        "extension",
        entry({
          activeEv: "ev",
          activeBundleKey: "bundle",
          activeRuntimeDepsKey: "runtime",
          status: "running",
        }),
        {
          source: "extensions/display",
          displayName: "Display Name",
        }
      )
    ).toEqual({
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
    expect(
      unitWorkspaceLogRecord(
        "app",
        "workspace-1",
        entry({
          unitKind: "app",
          name: "@workspace-apps/shell",
          status: "error",
          lastError: "boom",
        })
      )
    ).toEqual({
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
  function identity(
    overrides: Partial<UnitBuildIdentity<"extension">> = {}
  ): UnitBuildIdentity<"extension"> {
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

    expect(
      resolver.resolve({
        identity: candidate,
        entry: entry({
          activeBundleKey: "bundle",
          activeEv: "ev",
          activeDependencyEvs: { "@workspace/runtime": "ev-runtime" },
          activeExternalDeps: { leftpad: "1.0.0" },
          status: "running",
        }),
      }).decision
    ).toBe("user-approved");
    expect(
      resolver.resolve({
        identity: candidate,
        entry: entry({
          activeBundleKey: "bundle",
          activeEv: "ev-old",
          activeDependencyEvs: { "@workspace/runtime": "ev-runtime" },
          activeExternalDeps: { leftpad: "1.0.0" },
          status: "running",
        }),
      }).decision
    ).toBe("needs-approval");
    expect(
      resolver.resolve({
        identity: candidate,
        entry: entry({
          activeBundleKey: null,
          activeEv: "ev",
          activeDependencyEvs: { "@workspace/runtime": "ev-runtime" },
          activeExternalDeps: { leftpad: "1.0.0" },
          status: "pending-approval",
        }),
      }).decision
    ).toBe("needs-approval");
  });

  it("does not reuse approval when the candidate identity is incomplete", () => {
    const resolver = new UnitTrustResolver<UnitRegistryEntryBase>();
    const candidate = identity({ effectiveVersion: null });

    expect(
      resolver.resolve({
        identity: candidate,
        entry: entry({
          activeBundleKey: "bundle",
          activeEv: "ev",
          activeDependencyEvs: { "@workspace/runtime": "ev-runtime" },
          activeExternalDeps: { leftpad: "1.0.0" },
          status: "running",
        }),
      }).decision
    ).toBe("needs-approval");
  });

  it("does not reuse approval across capability identity drift", () => {
    const resolver = new UnitTrustResolver<UnitRegistryEntryBase>({
      entryIdentity: (approved) => unitBuildIdentityFromRegistryEntry(approved),
    });

    expect(
      resolver.resolve({
        identity: identity({ capabilities: ["notifications"] }),
        entry: entry({
          activeBundleKey: "bundle",
          activeEv: "ev",
          activeDependencyEvs: { "@workspace/runtime": "ev-runtime" },
          activeExternalDeps: { leftpad: "1.0.0" },
          status: "running",
        }),
      }).decision
    ).toBe("needs-approval");
  });

  it("returns preapproved for exact preapproved identity keys", () => {
    const resolver = new UnitTrustResolver<UnitRegistryEntryBase>();
    const candidate = identity();

    expect(
      resolver.resolve({
        identity: candidate,
        entry: null,
        preapprovedIdentityKeys: new Set([canonicalUnitBuildIdentity(candidate)]),
      }).decision
    ).toBe("preapproved");
    expect(
      resolver.resolve({
        identity: identity({ effectiveVersion: "ev-next" }),
        entry: null,
        preapprovedIdentityKeys: new Set([canonicalUnitBuildIdentity(candidate)]),
      }).decision
    ).toBe("needs-approval");
  });
});

describe("UnitHost", () => {
  interface TestNode extends UnitGraphNode {
    version: string;
  }
  type TestDecl = UnitDeclaration;
  type TestApproval = { name: string; ref: string };

  function makeHarness(
    opts: {
      active?: boolean;
      extraNode?: TestNode;
      applyTrusted?: (node: TestNode) => Promise<void>;
      isAdmitted?: (repoPath: string, effectiveVersion: string) => boolean;
      /** Stands in for the durable activation-trust file. */
      approvalStore?: {
        has(key: string): boolean;
        approveMany(keys: Iterable<string>): void;
        prepareApproveMany(keys: Iterable<string>): {
          committed(): void;
          failed(error: unknown): void;
        };
      };
    } = {}
  ) {
    const root = tempRoot();
    const registry = new UnitRegistry<UnitRegistryEntryBase>({
      statePath: root,
      unitKind: "extension",
    });
    if (opts.active) {
      registry.upsert(
        entry({
          activeBundleKey: "bundle",
          activeEv: "ev",
          status: "running",
        })
      );
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
      ...(opts.approvalStore ? { approvalStore: opts.approvalStore } : {}),
      ...(opts.isAdmitted
        ? {
            isAdmitted: (identity: { source: { repo: string }; effectiveVersion: string | null }) =>
              identity.effectiveVersion !== null &&
              opts.isAdmitted!(identity.source.repo, identity.effectiveVersion),
          }
        : {}),
      resolveNode: (source) => {
        const match = nodes.find(
          (candidate) => source === candidate.relativePath || source === candidate.name
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
      makePendingEntry: (n, decl, building) =>
        entry({
          name: n.name,
          source: { kind: "workspace-repo", repo: n.relativePath, ref: decl.ref },
          status: building ? "building" : "pending-approval",
        }),
      applyTrusted: async (n) => {
        applied.push(n.name);
        await opts.applyTrusted?.(n);
      },
      removeUndeclared: async (candidate) => {
        removed.push(candidate.name);
      },
      emitRemoved: () => undefined,
      notifyUnresolved: () => undefined,
      approvalEntry: (n, decl) => ({ name: n.name, ref: decl.ref }),
      requestApproval: async (entries) => {
        prompted.push(entries);
        return "accepted";
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

  it("retains a top-level reconciliation failure after staged waiters are released", async () => {
    const { host } = makeHarness({
      active: true,
      applyTrusted: async () => {
        throw new Error("reconcile failed");
      },
    });

    await expect(
      host.reconcileDeclared([{ source: "extensions/a", ref: "main" }], {
        waitFor: "applied",
      })
    ).rejects.toThrow("reconcile failed");

    await host.whenReconciled();
    expect(host.reconciliationError()).toBe("reconcile failed");
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

  it("retracts prepared activation trust when the publication fails", async () => {
    const { host, applied, prompted } = makeHarness();
    const declarations = [{ source: "extensions/a", ref: "main" }];
    const approval = host.approvalForDeclarations(declarations);
    const transaction = host.preparePreapprovedTrust(approval.identityKeys);

    transaction.failed(new Error("protected refs rejected the publication"));
    await host.reconcileDeclared(declarations);
    await host.whenSettled();

    expect(prompted).toEqual([[{ name: "@workspace-extensions/a", ref: "main" }]]);
    expect(applied).toEqual(["@workspace-extensions/a"]);
  });

  // Activation trust is downstream of admission. A unit carrying trust from
  // before admission was recorded has not had the review the authority model now
  // requires, and warm launches would otherwise never ask for it — the gate
  // stays quiet forever while the authority gate treats the unit as unreviewed.
  it("re-offers a trusted declaration whose version holds no admission", () => {
    // Durable activation trust from an earlier launch says this build may run.
    const trusted = new Set<string>();
    const approvalStore = {
      has: (key: string) => trusted.has(key),
      approveMany: (keys: Iterable<string>) => {
        for (const key of keys) trusted.add(key);
      },
      prepareApproveMany: (keys: Iterable<string>) => {
        const added = [...keys].filter((key) => !trusted.has(key));
        for (const key of added) trusted.add(key);
        return {
          committed: () => undefined,
          failed: () => {
            for (const key of added) trusted.delete(key);
          },
        };
      },
    };
    const admitted = new Set<string>();
    const { host } = makeHarness({
      approvalStore,
      isAdmitted: (repoPath, effectiveVersion) => admitted.has(`${repoPath}@${effectiveVersion}`),
    });
    const declarations = [{ source: "extensions/a", ref: "main" }];
    host.acceptPreapprovedTrust(host.approvalForDeclarations(declarations).identityKeys);
    expect(trusted.size).toBe(1);

    // Trusted but un-admitted: still offered, because trust alone is not the
    // review the authority model requires.
    expect(host.approvalForDeclarations(declarations).identityKeys).toHaveLength(1);

    // Once the version is admitted, trust stands and the gate goes quiet.
    admitted.add("extensions/a@ev");
    expect(host.approvalForDeclarations(declarations).identityKeys).toEqual([]);
  });

  it("retains exact preapproval for declarations not included in an earlier subset reconcile", async () => {
    const second: TestNode = {
      name: "@workspace-extensions/b",
      relativePath: "extensions/b",
      version: "1.0.0",
    };
    const { host, applied, prompted, node } = makeHarness({ extraNode: second });
    const declarations = [
      { source: node.relativePath, ref: "main" },
      { source: second.relativePath, ref: "main" },
    ];
    const approval = host.approvalForDeclarations(declarations);

    host.acceptPreapprovedTrust(approval.identityKeys);
    await host.reconcileDeclared([declarations[0]!], { removeUndeclared: false });
    await host.reconcileDeclared([declarations[1]!], { removeUndeclared: false });
    await host.whenSettled();

    expect(applied).toEqual([node.name, second.name]);
    expect(prompted).toEqual([]);
  });

  it("bounds background apply concurrency without changing declaration order", async () => {
    const second: TestNode = {
      name: "@workspace-extensions/b",
      relativePath: "extensions/b",
      version: "1.0.0",
    };
    let active = 0;
    let maxActive = 0;
    const releases: Array<() => void> = [];
    const { host, applied, node } = makeHarness({
      extraNode: second,
      applyTrusted: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
      },
    });
    const declarations = [
      { source: node.relativePath, ref: "main" },
      { source: second.relativePath, ref: "main" },
    ];
    host.acceptPreapprovedTrust(host.approvalForDeclarations(declarations).identityKeys);

    const reconcile = host.reconcileDeclared(declarations, { maxConcurrentApplies: 1 });
    await vi.waitFor(() => expect(applied).toEqual([node.name]));
    releases.shift()?.();
    await vi.waitFor(() => expect(applied).toEqual([node.name, second.name]));
    releases.shift()?.();
    await reconcile;

    expect(maxActive).toBe(1);
  });

  it("honors removeUndeclared while applying trusted declarations", async () => {
    const { host, registry, removed, node } = makeHarness({ active: true });
    registry.upsert(
      entry({
        name: "@workspace-extensions/old",
        source: { kind: "workspace-repo", repo: "extensions/old", ref: "main" },
        activeBundleKey: "old-bundle",
        status: "running",
      })
    );

    await host.reconcileDeclared([{ source: node.relativePath, ref: "main" }], {
      removeUndeclared: true,
    });
    expect(removed).toEqual(["@workspace-extensions/old"]);
    expect(registry.get("@workspace-extensions/old")).toBeNull();
  });

  it("collects approval entries for untrusted declarations", () => {
    const { host, node } = makeHarness();

    expect(
      host.approvalForDeclarations([
        { source: node.relativePath, ref: "main" },
        { source: "extensions/missing", ref: "main" },
      ])
    ).toEqual({
      entries: [{ name: node.name, ref: "main" }],
      identityKeys: [expect.any(String)],
    });
  });

  it("does not collect approval entries for already approved declarations", () => {
    const { host, node } = makeHarness({ active: true });

    expect(host.approvalForDeclarations([{ source: node.relativePath, ref: "main" }])).toEqual({
      entries: [],
      identityKeys: [],
    });
  });

  it("resolves declaration trust through the host identity pipeline", () => {
    const { host, node } = makeHarness({ active: true });

    expect(
      host.trustForDeclaration(node, {
        source: node.relativePath,
        ref: "main",
      })
    ).toMatchObject({ decision: "user-approved" });
    expect(
      host.trustForDeclaration(node, {
        source: node.relativePath,
        ref: "feature",
      })
    ).toMatchObject({ decision: "needs-approval" });
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

    registry.delete(node.name);
    await host.applyRuntimeDeclaration({
      node,
      decl: { source: node.relativePath, ref: "main" },
      needsBuildRefresh: () => true,
      deferBuild: () => true,
      buildAndActivate: async (n) => {
        built.push(`deferred:${n.name}`);
      },
      activateCurrent: async () => {
        activated.push("deferred");
      },
    });
    expect(registry.get(node.name)).toMatchObject({
      status: "available",
      activeBundleKey: null,
    });
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
    expect(
      host.needsBuildRefresh(active, {
        sourceRepo: "extensions/a",
        ref: "main",
        effectiveVersion: "ev",
        dependencyEvs: { dep: "ev-dep" },
        externalDeps: { leftpad: "1.0.0" },
        runtimeDepsKey: "runtime-key",
      })
    ).toBe(false);
    expect(
      host.needsBuildRefresh(active, {
        sourceRepo: "extensions/a",
        ref: "feature",
        effectiveVersion: "ev",
        dependencyEvs: { dep: "ev-dep" },
        externalDeps: { leftpad: "1.0.0" },
        runtimeDepsKey: "runtime-key",
      })
    ).toBe(true);
    expect(
      host.needsBuildRefresh(active, {
        sourceRepo: "extensions/a",
        ref: "main",
        effectiveVersion: "ev-next",
        dependencyEvs: { dep: "ev-dep" },
        externalDeps: { leftpad: "1.0.0" },
        runtimeDepsKey: "runtime-key",
      })
    ).toBe(true);
    expect(
      host.needsBuildRefresh(active, {
        sourceRepo: "extensions/a",
        ref: "main",
        effectiveVersion: "ev",
        dependencyEvs: { dep: "ev-next" },
        externalDeps: { leftpad: "1.0.0" },
        runtimeDepsKey: "runtime-key",
      })
    ).toBe(true);
    expect(
      host.needsBuildRefresh(active, {
        sourceRepo: "extensions/a",
        ref: "main",
        effectiveVersion: "ev",
        dependencyEvs: { dep: "ev-dep" },
        externalDeps: { leftpad: "2.0.0" },
        runtimeDepsKey: "runtime-key",
      })
    ).toBe(true);
    expect(
      host.needsBuildRefresh(active, {
        sourceRepo: "extensions/a",
        ref: "main",
        effectiveVersion: "ev",
        dependencyEvs: { dep: "ev-dep" },
        externalDeps: { leftpad: "1.0.0" },
        runtimeDepsKey: "runtime-next",
      })
    ).toBe(true);
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
    registry.upsert(
      entry({
        name: extraNode.name,
        source: { kind: "workspace-repo", repo: extraNode.relativePath, ref: "main" },
        activeBundleKey: "bundle-b",
        activeEv: "ev",
        status: "running",
      })
    );

    await host.reconcileDeclared([{ source: "extensions/a", ref: "main" }], {
      removeUndeclared: false,
    });
    await host.whenSettled();

    expect(removed).toEqual([]);
    expect(registry.get("@workspace-extensions/a")).toMatchObject({ status: "running" });
    expect(registry.get("@workspace-extensions/b")).toMatchObject({ status: "running" });
  });
});

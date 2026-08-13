import { describe, expect, it, vi } from "vitest";
import type { UserlandCapabilityDefinition } from "@vibestudio/shared/authorityManifest";
import type { BuildUnitIdentityResolution } from "../buildV2/index.js";
import { createBuildUnitChangeApprovalProvider } from "./buildUnitChangeApprovalProvider.js";

const state = `state:${"a".repeat(64)}`;
const previousState = `state:${"b".repeat(64)}`;

function manifest(
  capability: string,
  presentation: { displayName?: string; title?: string } = { displayName: "Example panel" },
  provides: readonly UserlandCapabilityDefinition[] = []
): BuildUnitIdentityResolution["manifest"] {
  return {
    ...presentation,
    authority: {
      provides,
      requests: [
        {
          capability,
          resource: { kind: "exact", key: "workspace" },
          tier: "gated",
          evidence: "exact",
        },
      ],
    },
  };
}

function identity(
  overrides: Partial<BuildUnitIdentityResolution> = {}
): BuildUnitIdentityResolution {
  return {
    unitPath: "panels/example",
    unitName: "@workspace-panels/example",
    kind: "panel",
    stateHash: previousState,
    effectiveVersion: "ev-old",
    manifest: manifest("window-management"),
    packageVersion: "0.1.0",
    dependencyEvs: { "@workspace/runtime": "runtime-old" },
    externalDeps: {},
    serviceBindings: [],
    ...overrides,
  };
}

function approvalStore() {
  // `has` answers for a whole identity (path, version, and declaration);
  // `hasVersion` is the same question keyed by version alone.
  // Typed with both fields the real `has` reads, so a test that answers by repo
  // path is as well-typed as one that answers by version.
  const has = vi.fn((_candidate: { repoPath?: string; effectiveVersion?: string }) => false);
  const admitMany = vi.fn();
  return {
    has,
    hasVersion: vi.fn((repoPath: string, effectiveVersion: string) =>
      has({ repoPath, effectiveVersion })
    ),
    // What the creation review actually asks: has this PART ever been reviewed?
    // Defaults to "never", which is the fresh-workspace case.
    latestAdmittedVersion: vi.fn((_repoPath: string): string | null => null),
    admit: vi.fn(),
    admitMany,
    beginTransaction: vi.fn(() => ({
      admitMany,
      committed: vi.fn(),
      failed: vi.fn(),
    })),
  };
}

describe("createBuildUnitChangeApprovalProvider", () => {
  it("uses the workspace resolver for both sides of an authority diff", async () => {
    const buildSystem = {
      listBuildUnitIdentities: vi.fn(async (ref?: string) => [
        identity({
          stateHash: ref ? state : previousState,
          effectiveVersion: ref ? "ev-new" : "ev-old",
          manifest: manifest(ref ? "provider.effect.next" : "provider.effect.previous"),
        }),
      ]),
    };
    const describeCapability = vi.fn((capability: string) => ({
      title: capability,
      action: `use ${capability}`,
      description: `Use ${capability}`,
      group: "runtime",
      authorityCategory: { domain: "automation" as const, verb: "act" as const },
    }));
    const provider = createBuildUnitChangeApprovalProvider({
      getBuildSystem: () => buildSystem as never,
      admissionStore: approvalStore() as never,
      describeCapability,
    });

    await expect(provider.unitChangeApprovalForCommit(state)).resolves.toMatchObject({
      units: [{ authority: { requests: [{ capability: "provider.effect.next" }] } }],
    });
    expect(describeCapability).toHaveBeenCalledWith("provider.effect.previous", "panel");
    expect(describeCapability).toHaveBeenCalledWith("provider.effect.next", "panel");
  });

  it("uses a manifest title when a unit has no separate display name", async () => {
    const buildSystem = {
      listBuildUnitIdentities: vi.fn(async (ref?: string) =>
        ref
          ? [
              identity({
                stateHash: state,
                effectiveVersion: "ev-new",
                manifest: manifest("notifications", { title: "About Vibestudio" }),
              }),
            ]
          : [identity({ manifest: manifest("window-management", { title: "About Vibestudio" }) })]
      ),
    };
    const store = approvalStore();
    const provider = createBuildUnitChangeApprovalProvider({
      getBuildSystem: () => buildSystem as never,
      admissionStore: store as never,
      describeCapability: (capability) => ({
        title: capability,
        action: capability,
        description: capability,
        group: "other",
      }),
    });

    const review = await provider.unitChangeApprovalForCommit(state);

    expect(review.units[0]?.displayName).toBe("About Vibestudio");
  });

  it("surfaces an affected panel and its added authority from the exact candidate view", async () => {
    const buildSystem = {
      listBuildUnitIdentities: vi.fn(async (ref?: string) =>
        ref
          ? [
              identity({
                stateHash: state,
                effectiveVersion: "ev-new",
                dependencyEvs: { "@workspace/runtime": "runtime-new" },
                manifest: manifest("notifications"),
              }),
            ]
          : [identity()]
      ),
    };
    const store = approvalStore();
    const provider = createBuildUnitChangeApprovalProvider({
      getBuildSystem: () => buildSystem as never,
      admissionStore: store as never,
      describeCapability: (capability) => ({
        title: capability === "notifications" ? "Show notifications" : "Navigate panels",
        action: capability === "notifications" ? "show notifications" : "navigate panels",
        description: `Use ${capability}`,
        group: "runtime",
      }),
    });

    const review = await provider.unitChangeApprovalForCommit(state);

    expect(buildSystem.listBuildUnitIdentities).toHaveBeenNthCalledWith(1, state, [
      "panel",
      "worker",
    ]);
    expect(review.units).toHaveLength(1);
    expect(review.units[0]).toMatchObject({
      unitKind: "panel",
      displayName: "Example panel",
      ev: "ev-new",
      authority: {
        diff: {
          added: [expect.objectContaining({ capability: "notifications" })],
          removed: [expect.objectContaining({ capability: "window-management" })],
        },
      },
    });
    expect(review.units[0]?.authority?.rows).toContainEqual(
      expect.objectContaining({ capability: "notifications", domain: "computer" })
    );
    expect(review.identityKeys[0]).toMatch(/^workspace-unit:[0-9a-f]{64}$/u);

    provider.acceptPreapprovedTrust(review.identityKeys);
    expect(store.admitMany).toHaveBeenCalledWith(
      [
        {
          repoPath: "panels/example",
          effectiveVersion: "ev-new",
          authority: {
            provides: [],
            serviceRequests: [],
            requests: [
              {
                capability: "notifications",
                resource: { kind: "exact", key: "workspace" },
                tier: "gated",
                evidence: "exact",
              },
            ],
          },
          serviceBindingDigest: "4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
        },
      ],
      "publication"
    );
  });

  it("reviews a provides-only authority change", async () => {
    const service = {
      name: "notes",
      title: "Team notes",
      action: "provide team notes",
      description: "Let other workspace parts use team notes.",
      tier: "gated",
      sensitivity: "write",
      resourceType: "workspace.notes",
      presentation: { domain: "files", verb: "act" },
      notability: "headline",
      grantScopes: ["session"],
    } satisfies UserlandCapabilityDefinition;
    const buildSystem = {
      listBuildUnitIdentities: vi.fn(async (ref?: string) =>
        ref
          ? [
              identity({
                stateHash: state,
                effectiveVersion: "ev-new",
                manifest: manifest("notifications", undefined, [service]),
              }),
            ]
          : [identity({ manifest: manifest("notifications") })]
      ),
    };
    const provider = createBuildUnitChangeApprovalProvider({
      getBuildSystem: () => buildSystem as never,
      admissionStore: approvalStore() as never,
      describeCapability: (capability) => ({
        title: capability,
        action: capability,
        description: capability,
        group: "runtime",
      }),
    });

    const review = await provider.unitChangeApprovalForCommit(state);

    expect(review.units).toHaveLength(1);
    expect(review.units[0]?.authority).toMatchObject({
      requests: expect.any(Array),
      previousProvides: [],
      provides: [service],
    });
  });

  it("does not create a version prompt for an unchanged exact identity", async () => {
    const unchanged = identity();
    const provider = createBuildUnitChangeApprovalProvider({
      getBuildSystem: () => ({ listBuildUnitIdentities: vi.fn(async () => [unchanged]) }) as never,
      admissionStore: approvalStore() as never,
      describeCapability: (capability) => ({
        title: capability,
        action: capability,
        description: capability,
        group: "other",
      }),
    });

    await expect(provider.unitChangeApprovalForCommit(state)).resolves.toMatchObject({
      units: [],
      identityKeys: [],
    });
  });

  it("the creation review names only current exact versions without a prior admission", async () => {
    const panel = identity({ stateHash: state, effectiveVersion: "ev-panel" });
    const worker = identity({
      unitPath: "workers/example",
      unitName: "@workspace-workers/example",
      kind: "worker",
      stateHash: state,
      effectiveVersion: "ev-worker",
    });
    const store = approvalStore();
    store.has.mockImplementation((candidate) => candidate.effectiveVersion === "ev-panel");
    const provider = createBuildUnitChangeApprovalProvider({
      getBuildSystem: () =>
        ({ listBuildUnitIdentities: vi.fn(async () => [panel, worker]) }) as never,
      admissionStore: store as never,
      describeCapability: (capability) => ({
        title: capability,
        action: capability,
        description: capability,
        group: "other",
      }),
    });

    const review = await provider.creationReview();

    expect(review.units).toHaveLength(1);
    expect(review.units[0]).toMatchObject({
      unitKind: "worker",
      unitName: "@workspace-workers/example",
      ev: "ev-worker",
    });
  });

  it("owes nothing for a part it has reviewed before, even at a different version", async () => {
    // This runs on every boot forever, so it has to be answerable from the
    // admission index alone. It also has to key on the PART, not the version:
    // an effective version commits `dependencyEvs`, so a host upgrade moves
    // every unit's EV at once. Keyed on the version, the boot after any upgrade
    // would greet the user with the whole workspace as a creation review — the
    // card §5.4 and U7 exist to delete.
    const store = approvalStore();
    store.latestAdmittedVersion.mockImplementation(() => "ev-from-a-previous-release");
    const provider = createBuildUnitChangeApprovalProvider({
      getBuildSystem: () =>
        ({
          listBuildUnitIdentities: vi.fn(async () => [
            identity({ stateHash: state, effectiveVersion: "ev-panel" }),
          ]),
        }) as never,
      admissionStore: store as never,
      describeCapability: (capability) => ({
        title: capability,
        action: capability,
        description: capability,
        group: "other",
      }),
    });

    await expect(provider.creationReview()).resolves.toMatchObject({ units: [], identityKeys: [] });
  });

  it("still owes the review for a workspace whose admissions cover only host-build units", async () => {
    // The regression this guards. The obligation used to be read from a durable
    // marker, falling back to "the admission store is empty" — and neither can
    // be true for a workspace that predates the marker: seed-trusted host-build
    // units are admitted before the check runs, so the store is never empty.
    // Every such workspace skipped its review, admitted no panel or worker, and
    // minted no clearance at all. Asking the parts themselves is the only
    // question that answers correctly however the workspace got here.
    const store = approvalStore();
    store.latestAdmittedVersion.mockImplementation((repoPath) =>
      repoPath === "apps/shell" ? "ev-shell" : null
    );
    const provider = createBuildUnitChangeApprovalProvider({
      getBuildSystem: () =>
        ({
          listBuildUnitIdentities: vi.fn(async () => [
            identity({ stateHash: state, effectiveVersion: "ev-panel" }),
          ]),
        }) as never,
      admissionStore: store as never,
      describeCapability: (capability) => ({
        title: capability,
        action: capability,
        description: capability,
        group: "other",
      }),
    });

    const review = await provider.creationReview();

    expect(review.units).toHaveLength(1);
    expect(review.units[0]).toMatchObject({ unitKind: "panel", ev: "ev-panel" });
  });
});

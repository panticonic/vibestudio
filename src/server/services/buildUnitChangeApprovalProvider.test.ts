import { describe, expect, it, vi } from "vitest";
import type { BuildUnitIdentityResolution } from "../buildV2/index.js";
import { createBuildUnitChangeApprovalProvider } from "./buildUnitChangeApprovalProvider.js";

const state = `state:${"a".repeat(64)}`;
const previousState = `state:${"b".repeat(64)}`;

function identity(
  overrides: Partial<BuildUnitIdentityResolution> = {}
): BuildUnitIdentityResolution {
  return {
    unitPath: "panels/example",
    unitName: "@workspace-panels/example",
    kind: "panel",
    stateHash: previousState,
    effectiveVersion: "ev-old",
    dependencyEvs: { "@workspace/runtime": "runtime-old" },
    externalDeps: {},
    ...overrides,
  };
}

function packageJson(capability: string): string {
  return JSON.stringify({
    name: "@workspace-panels/example",
    version: "0.1.0",
    vibestudio: {
      displayName: "Example panel",
      authority: {
        requests: [
          {
            capability,
            resource: { kind: "exact", key: "workspace" },
            tier: "gated",
            evidence: "exact",
          },
        ],
      },
    },
  });
}

function approvalStore() {
  return {
    has: vi.fn((_candidate: { effectiveVersion: string }) => false),
    approve: vi.fn(),
    approveMany: vi.fn(),
  };
}

describe("createBuildUnitChangeApprovalProvider", () => {
  it("surfaces an affected panel and its added authority from the exact candidate view", async () => {
    const buildSystem = {
      listBuildUnitIdentities: vi.fn(async (ref?: string) =>
        ref
          ? [
              identity({
                stateHash: state,
                effectiveVersion: "ev-new",
                dependencyEvs: { "@workspace/runtime": "runtime-new" },
              }),
            ]
          : [identity()]
      ),
    };
    const readWorkspaceFileAtState = vi.fn(async (at: string) =>
      at === state ? packageJson("notifications") : packageJson("window-management")
    );
    const store = approvalStore();
    const provider = createBuildUnitChangeApprovalProvider({
      getBuildSystem: () => buildSystem as never,
      readWorkspaceFileAtState,
      approvalStore: store as never,
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
    expect(store.approveMany).toHaveBeenCalledWith([
      {
        repoPath: "panels/example",
        effectiveVersion: "ev-new",
        authority: {
          requests: [
            {
              capability: "notifications",
              resource: { kind: "exact", key: "workspace" },
              tier: "gated",
              evidence: "exact",
            },
          ],
        },
      },
    ]);
  });

  it("does not create a version prompt for an unchanged exact identity", async () => {
    const unchanged = identity();
    const provider = createBuildUnitChangeApprovalProvider({
      getBuildSystem: () => ({ listBuildUnitIdentities: vi.fn(async () => [unchanged]) }) as never,
      readWorkspaceFileAtState: vi.fn(),
      approvalStore: approvalStore() as never,
      describeCapability: (capability) => ({
        title: capability,
        action: capability,
        description: capability,
        group: "other",
      }),
    });

    await expect(provider.unitChangeApprovalForCommit(state)).resolves.toEqual({
      units: [],
      identityKeys: [],
    });
  });

  it("batches only current exact versions without a prior admission", async () => {
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
      readWorkspaceFileAtState: vi.fn(async (_at, path) =>
        packageJson(path.startsWith("workers/") ? "notifications" : "window-management").replace(
          "@workspace-panels/example",
          path.startsWith("workers/") ? "@workspace-workers/example" : "@workspace-panels/example"
        )
      ),
      approvalStore: store as never,
      describeCapability: (capability) => ({
        title: capability,
        action: capability,
        description: capability,
        group: "other",
      }),
    });

    const review = await provider.startupApproval();

    expect(review.units).toHaveLength(1);
    expect(review.units[0]).toMatchObject({
      unitKind: "worker",
      unitName: "@workspace-workers/example",
      ev: "ev-worker",
    });
  });
});

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { mkdir } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  HostTarget,
  HostTargetCandidate,
  HostTargetSelection,
} from "@vibestudio/shared/hostTargets";
import { stateLayout } from "./stateLayout.js";
import {
  FileHostTargetSelectionStore,
  HostTargetSelectionPolicy,
  type HostTargetSelectionStore,
} from "./hostTargetSelection.js";

class MemorySelectionStore implements HostTargetSelectionStore {
  selections: HostTargetSelection[] = [];

  list(): HostTargetSelection[] {
    return [...this.selections];
  }

  replace(selection: HostTargetSelection): void {
    this.clear(selection.workspaceId, selection.target);
    this.selections.push(selection);
  }

  clear(workspaceId: string, target: HostTarget): void {
    this.selections = this.selections.filter(
      (selection) => !(selection.workspaceId === workspaceId && selection.target === target)
    );
  }
}

function candidate(
  source: string,
  overrides: Partial<HostTargetCandidate> = {}
): HostTargetCandidate {
  return {
    name: `@workspace-apps/${source.split("/").at(-1)}`,
    source,
    target: "electron",
    declared: true,
    status: "running",
    activeEv: "ev",
    activeBundleKey: "build-1",
    capabilities: ["panel-hosting"],
    canRollback: false,
    previousVersions: [],
    lastError: null,
    compatibility: { selectable: true, reasons: [], recommended: true },
    ...overrides,
  };
}

function makePolicy(
  options: {
    candidates?: HostTargetCandidate[];
    declaredSource?: string | null;
    entries?: Array<{
      name: string;
      target: HostTarget;
      source: { repo: string };
      status: string;
      activeBundleKey: string | null;
    }>;
    retainedBuilds?: string[];
    store?: MemorySelectionStore;
  } = {}
) {
  const store = options.store ?? new MemorySelectionStore();
  const candidates = options.candidates ?? [candidate("apps/shell")];
  const retainedBuilds = options.retainedBuilds ?? ["build-1"];
  const policy = new HostTargetSelectionPolicy({
    workspaceId: "workspace-a",
    store,
    listCandidates: (target) => candidates.filter((item) => item.target === target),
    listVersions: () => ({
      current: retainedBuilds[0] ? { activeBundleKey: retainedBuilds[0] } : null,
      previous: retainedBuilds.slice(1).map((activeBundleKey) => ({ activeBundleKey })),
    }),
    listEntries: () => options.entries ?? [],
    declaredSource: () => options.declaredSource ?? null,
  });
  return { policy, store };
}

describe("HostTargetSelectionPolicy", () => {
  it("derives an unsaved default from the manifest-preferred selectable app", () => {
    const { policy, store } = makePolicy({
      candidates: [
        candidate("apps/other", {
          name: "@workspace-apps/other",
          compatibility: { selectable: true, reasons: [], recommended: true },
        }),
        candidate("apps/shell", {
          name: "@workspace-apps/shell",
          compatibility: { selectable: true, reasons: [], recommended: false },
        }),
      ],
      declaredSource: "/apps/shell",
    });

    expect(policy.get("electron")).toEqual({
      valid: true,
      selection: expect.objectContaining({
        source: "apps/shell",
        appId: "@workspace-apps/shell",
        autoSelected: true,
        updatedAt: 0,
      }),
    });
    expect(store.list()).toEqual([]);
  });

  it("persists explicit selections and reports when their candidate disappears", () => {
    const shell = candidate("apps/shell");
    const candidates = [shell];
    const store = new MemorySelectionStore();
    const policy = new HostTargetSelectionPolicy({
      workspaceId: "workspace-a",
      store,
      listCandidates: () => candidates,
      listVersions: () => ({ current: { activeBundleKey: "build-1" }, previous: [] }),
      listEntries: () => [],
      declaredSource: () => null,
    });

    expect(policy.set("electron", { source: "apps/shell" })).toMatchObject({
      source: "apps/shell",
      mode: "follow-ref",
    });
    candidates.length = 0;
    expect(policy.get("electron")).toMatchObject({
      valid: false,
      reason: "Selected app is no longer available",
    });
  });

  it("validates compatibility and retained pinned builds before writing", () => {
    const incompatible = candidate("apps/shell", {
      compatibility: {
        selectable: false,
        reasons: ["panel-hosting is required"],
        recommended: false,
      },
    });
    const incompatiblePolicy = makePolicy({ candidates: [incompatible] }).policy;
    expect(() => incompatiblePolicy.set("electron", { source: "apps/shell" })).toThrow(
      "panel-hosting is required"
    );

    const policy = makePolicy().policy;
    expect(() =>
      policy.set("electron", {
        source: "apps/shell",
        mode: "pinned-build",
        buildKey: "missing-build",
      })
    ).toThrow("Build missing-build is not retained");
  });

  it("resolves invalid selections through the preferred active app", () => {
    const store = new MemorySelectionStore();
    store.selections.push({
      workspaceId: "workspace-a",
      target: "electron",
      source: "apps/removed",
      appId: "@workspace-apps/removed",
      mode: "follow-ref",
      updatedAt: 1,
    });
    const { policy } = makePolicy({
      candidates: [candidate("apps/shell"), candidate("apps/other")],
      declaredSource: "apps/shell",
      entries: [
        {
          name: "@workspace-apps/shell",
          target: "electron",
          source: { repo: "./apps/shell" },
          status: "running",
          activeBundleKey: "build-1",
        },
        {
          name: "@workspace-apps/other",
          target: "electron",
          source: { repo: "apps/other" },
          status: "running",
          activeBundleKey: "build-2",
        },
      ],
      store,
    });

    expect(policy.selectedSource("electron")).toBe("apps/shell");
  });

  it("matches pinned selections only to their selected entry", () => {
    const { policy } = makePolicy();
    policy.set("electron", {
      source: "apps/shell",
      mode: "pinned-build",
      buildKey: "build-1",
    });

    expect(
      policy.pinnedFor({
        name: "@workspace-apps/shell",
        target: "electron",
        source: { repo: "./apps/shell" },
        status: "running",
        activeBundleKey: "build-1",
      })
    ).toMatchObject({ buildKey: "build-1" });
    expect(
      policy.pinnedFor({
        name: "@workspace-apps/other",
        target: "electron",
        source: { repo: "apps/other" },
        status: "running",
        activeBundleKey: "build-2",
      })
    ).toBeNull();
  });
});

describe("FileHostTargetSelectionStore", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("round-trips valid selections and filters malformed records", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibestudio-host-target-selection-"));
    roots.push(root);
    const store = new FileHostTargetSelectionStore(root);
    store.replace({
      workspaceId: "workspace-a",
      target: "electron",
      source: "apps/shell",
      appId: "@workspace-apps/shell",
      mode: "follow-ref",
      updatedAt: 1,
    });
    expect(new FileHostTargetSelectionStore(root).list()).toHaveLength(1);

    const filePath = stateLayout(root).hostTargetSelectionsFile;
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(
      filePath,
      JSON.stringify({
        selections: [
          ...store.list(),
          { workspaceId: "workspace-a", target: "invalid", source: "apps/bad" },
        ],
      })
    );
    expect(new FileHostTargetSelectionStore(root).list()).toEqual(store.list());
  });

  it("treats unreadable state as empty without mutating it", async () => {
    const root = await mkdtemp(join(tmpdir(), "vibestudio-host-target-selection-"));
    roots.push(root);
    const filePath = stateLayout(root).hostTargetSelectionsFile;
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, "{");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(new FileHostTargetSelectionStore(root).list()).toEqual([]);
    expect(warning).toHaveBeenCalledOnce();
    warning.mockRestore();
  });
});

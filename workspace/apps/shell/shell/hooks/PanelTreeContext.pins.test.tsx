// @vitest-environment jsdom

import { render, screen, waitFor, act } from "@testing-library/react";
import { Provider, createStore, useAtomValue } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Panel } from "@vibestudio/shared/types";

// The shell client facade is mocked so we control the tree + pin sources.
const getTreeSnapshot = vi.fn();
const ensureOwnerTree = vi.fn();
const listPinnedPanelIds = vi.fn();
const getProfile = vi.fn(() =>
  Promise.resolve({ userId: "alice", handle: "alice", displayName: "Alice", role: "member" })
);
vi.mock("../client.js", () => ({
  ACCOUNT_PROFILE_CHANGED_EVENT: "account-profile-changed",
  panel: {
    getTreeSnapshot: (...args: unknown[]) => getTreeSnapshot(...args),
    ensureOwnerTree: (...args: unknown[]) => ensureOwnerTree(...args),
    listPinnedPanelIds: (...args: unknown[]) => listPinnedPanelIds(...args),
  },
  account: {
    getProfile: () => getProfile(),
    resolveProfiles: vi.fn(() => Promise.resolve({})),
  },
  workspace: {},
}));

// Capture the `panel-tree-updated` handler so a test can push a fresh snapshot.
let treeUpdateHandler: ((data: unknown) => void) | null = null;
vi.mock("../useShellEvent.js", () => ({
  useShellEvent: (event: string, handler: (data: unknown) => void) => {
    if (event === "panel-tree-updated") treeUpdateHandler = handler;
  },
}));

import { PanelTreeProvider, useRootPanels } from "./PanelTreeContext";
import { pinMutationSeqAtom, pinnedPanelIdsAtom } from "../../state/appModeAtoms";

function panel(id: string): Panel {
  return {
    id,
    title: id,
    children: [],
    snapshot: { source: `panels/${id}`, contextId: `ctx-${id}`, options: {} },
    artifacts: {},
  };
}

function PinProbe() {
  const pins = useAtomValue(pinnedPanelIdsAtom);
  return <div data-testid="pins">{[...pins].sort().join(",")}</div>;
}

function RootProbe() {
  const { panels, loading } = useRootPanels();
  return (
    <div data-testid="roots" data-loading={loading ? "true" : "false"}>
      {panels.map((item) => item.id).join(",")}
    </div>
  );
}

function renderProvider() {
  const store = createStore();
  render(
    <Provider store={store}>
      <PanelTreeProvider>
        <PinProbe />
        <RootProbe />
      </PanelTreeProvider>
    </Provider>
  );
  return store;
}

function emitTreeSnapshot(revision: number, rootPanels: Panel[]) {
  act(() => {
    treeUpdateHandler?.({ revision, forest: [{ owner: "", rootPanels }] });
  });
}

function emitForest(revision: number, forest: Array<{ owner: string; rootPanels: Panel[] }>) {
  act(() => treeUpdateHandler?.({ revision, forest }));
}

beforeEach(() => {
  treeUpdateHandler = null;
  getTreeSnapshot.mockReset();
  // Most tests drive the event path explicitly; leave the startup recovery
  // read pending so it cannot race those snapshots.
  getTreeSnapshot.mockImplementation(() => new Promise(() => {}));
  ensureOwnerTree.mockReset();
  ensureOwnerTree.mockImplementation(() => new Promise(() => {}));
  listPinnedPanelIds.mockReset();
  getProfile.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("PanelTreeProvider pin reconciliation", () => {
  it("seeds the pin atom from listPinnedPanelIds on the initial snapshot", async () => {
    listPinnedPanelIds.mockResolvedValue(["panel:tree/a"]);

    renderProvider();
    emitTreeSnapshot(1, [panel("panel:tree/a")]);

    await waitFor(() => expect(screen.getByTestId("pins").textContent).toBe("panel:tree/a"));
    expect(screen.getByTestId("roots").dataset["loading"]).toBe("true");
  });

  it("re-seeds on every tree update so a reused slot id drops its stale pin", async () => {
    // Initial: panel x is loaded and pinned.
    listPinnedPanelIds.mockResolvedValueOnce(["panel:tree/x"]);

    renderProvider();
    emitTreeSnapshot(1, [panel("panel:tree/x")]);
    await waitFor(() => expect(screen.getByTestId("pins").textContent).toBe("panel:tree/x"));

    // A later snapshot (x removed, a new panel under a *reused* slot id appears).
    // The main process is the source of truth and now reports no pins → the
    // atom must reconcile to empty rather than keep the stale 📌.
    listPinnedPanelIds.mockResolvedValue([]);
    emitTreeSnapshot(2, [panel("panel:tree/y")]);

    await waitFor(() => expect(screen.getByTestId("pins").textContent).toBe(""));
  });

  it("discards a reconcile response superseded by a local toggle (no clobber)", async () => {
    listPinnedPanelIds.mockResolvedValueOnce([]); // mount reconcile → empty
    const store = renderProvider();
    emitTreeSnapshot(1, [panel("panel:tree/x")]);
    await waitFor(() => expect(screen.getByTestId("pins").textContent).toBe(""));

    // The next reconcile (from a tree update) hangs until we resolve it.
    let resolveList: (ids: string[]) => void = () => {};
    listPinnedPanelIds.mockImplementationOnce(
      () =>
        new Promise<string[]>((res) => {
          resolveList = res;
        })
    );
    emitTreeSnapshot(2, [panel("panel:tree/x")]);

    // While that reconcile is in flight, a local toggle pins x and bumps the seq.
    act(() => {
      store.set(pinnedPanelIdsAtom, new Set(["panel:tree/x"]));
      store.set(pinMutationSeqAtom, (s) => s + 1);
    });
    await waitFor(() => expect(screen.getByTestId("pins").textContent).toBe("panel:tree/x"));

    // The stale reconcile resolves with the pre-toggle (empty) set; it must be
    // discarded, leaving the just-toggled pin intact.
    await act(async () => {
      resolveList([]);
    });
    expect(screen.getByTestId("pins").textContent).toBe("panel:tree/x");
  });

  it("loads the authoritative forest on mount to trigger account first attach", async () => {
    listPinnedPanelIds.mockResolvedValue([]);
    const snapshot = {
      revision: 1,
      forest: [{ owner: "alice", rootPanels: [panel("panel:tree/a")] }],
    };
    ensureOwnerTree.mockResolvedValue(snapshot);
    getTreeSnapshot.mockResolvedValue(snapshot);

    renderProvider();

    await waitFor(() => expect(screen.getByTestId("roots").textContent).toBe("panel:tree/a"));
    expect(screen.getByTestId("roots").dataset["loading"]).toBe("false");
    expect(ensureOwnerTree).toHaveBeenCalledOnce();
    expect(getTreeSnapshot).toHaveBeenCalledOnce();
    expect(listPinnedPanelIds).toHaveBeenCalled();
  });

  it("orders the verified account's owner group before other members", async () => {
    listPinnedPanelIds.mockResolvedValue([]);
    renderProvider();
    emitForest(1, [
      { owner: "bob", rootPanels: [panel("bob-root")] },
      { owner: "alice", rootPanels: [panel("alice-root")] },
    ]);

    await waitFor(() =>
      expect(screen.getByTestId("roots").textContent).toBe("alice-root,bob-root")
    );
  });
});

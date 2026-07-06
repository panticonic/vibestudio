// @vitest-environment jsdom

import { render, screen, waitFor, act } from "@testing-library/react";
import { Provider, createStore, useAtomValue } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Panel } from "@vibestudio/shared/types";

// The shell client facade is mocked so we control the tree + pin sources.
const getTreeSnapshot = vi.fn();
const listPinnedPanelIds = vi.fn();
vi.mock("../client.js", () => ({
  panel: {
    getTreeSnapshot: (...args: unknown[]) => getTreeSnapshot(...args),
    listPinnedPanelIds: (...args: unknown[]) => listPinnedPanelIds(...args),
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
  const { panels } = useRootPanels();
  return <div data-testid="roots">{panels.map((item) => item.id).join(",")}</div>;
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
    treeUpdateHandler?.({ revision, rootPanels });
  });
}

beforeEach(() => {
  treeUpdateHandler = null;
  getTreeSnapshot.mockReset();
  listPinnedPanelIds.mockReset();
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

  it("initializes from the subscription snapshot without a separate tree RPC", async () => {
    listPinnedPanelIds.mockResolvedValue([]);

    renderProvider();
    emitTreeSnapshot(1, [panel("panel:tree/a")]);

    await waitFor(() => expect(screen.getByTestId("roots").textContent).toBe("panel:tree/a"));
    expect(getTreeSnapshot).not.toHaveBeenCalled();
    expect(listPinnedPanelIds).toHaveBeenCalled();
  });
});

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

import { PanelTreeProvider } from "./PanelTreeContext";
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

function renderProvider() {
  const store = createStore();
  render(
    <Provider store={store}>
      <PanelTreeProvider>
        <PinProbe />
      </PanelTreeProvider>
    </Provider>
  );
  return store;
}

beforeEach(() => {
  treeUpdateHandler = null;
  getTreeSnapshot.mockReset();
  listPinnedPanelIds.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PanelTreeProvider pin reconciliation", () => {
  it("seeds the pin atom from listPinnedPanelIds on the initial snapshot", async () => {
    getTreeSnapshot.mockResolvedValue({ revision: 1, rootPanels: [panel("panel:tree/a")] });
    listPinnedPanelIds.mockResolvedValue(["panel:tree/a"]);

    renderProvider();

    await waitFor(() => expect(screen.getByTestId("pins").textContent).toBe("panel:tree/a"));
  });

  it("re-seeds on every tree update so a reused slot id drops its stale pin", async () => {
    // Initial: panel x is loaded and pinned.
    getTreeSnapshot.mockResolvedValue({ revision: 1, rootPanels: [panel("panel:tree/x")] });
    listPinnedPanelIds.mockResolvedValueOnce(["panel:tree/x"]);

    renderProvider();
    await waitFor(() => expect(screen.getByTestId("pins").textContent).toBe("panel:tree/x"));

    // A later snapshot (x removed, a new panel under a *reused* slot id appears).
    // The main process is the source of truth and now reports no pins → the
    // atom must reconcile to empty rather than keep the stale 📌.
    listPinnedPanelIds.mockResolvedValue([]);
    act(() => {
      treeUpdateHandler?.({ revision: 2, rootPanels: [panel("panel:tree/y")] });
    });

    await waitFor(() => expect(screen.getByTestId("pins").textContent).toBe(""));
  });

  it("discards a reconcile response superseded by a local toggle (no clobber)", async () => {
    getTreeSnapshot.mockResolvedValue({ revision: 1, rootPanels: [panel("panel:tree/x")] });
    listPinnedPanelIds.mockResolvedValueOnce([]); // mount reconcile → empty
    const store = renderProvider();
    await waitFor(() => expect(screen.getByTestId("pins").textContent).toBe(""));

    // The next reconcile (from a tree update) hangs until we resolve it.
    let resolveList: (ids: string[]) => void = () => {};
    listPinnedPanelIds.mockImplementationOnce(
      () =>
        new Promise<string[]>((res) => {
          resolveList = res;
        })
    );
    act(() => {
      treeUpdateHandler?.({ revision: 2, rootPanels: [panel("panel:tree/x")] });
    });

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
});

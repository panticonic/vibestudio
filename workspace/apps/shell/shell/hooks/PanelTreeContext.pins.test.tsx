// @vitest-environment jsdom

import { render, screen, waitFor, act, fireEvent } from "@testing-library/react";
import { Provider, createStore, useAtomValue } from "jotai";
import { useEffect, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The shell client facade is mocked so we control the tree + pin sources.
const getRootGroups = vi.fn();
const getTreePage = vi.fn();
const getTreePath = vi.fn();
const searchTree = vi.fn();
const listPinnedPanelIds = vi.fn();
const getPresentation = vi.fn();
const getPresentations = vi.fn((panelIds: string[]) =>
  Promise.all(panelIds.map((panelId) => getPresentation(panelId))).then((presentations) =>
    presentations.filter((presentation) => presentation != null)
  )
);
const getProfile = vi.fn(() =>
  Promise.resolve({ userId: "alice", handle: "alice", displayName: "Alice", role: "member" })
);
vi.mock("../client.js", () => ({
  ACCOUNT_PROFILE_CHANGED_EVENT: "account-profile-changed",
  panel: {
    getRootGroups: (...args: unknown[]) => getRootGroups(...args),
    getTreePage: (...args: unknown[]) => getTreePage(...args),
    getTreePath: (...args: unknown[]) => getTreePath(...args),
    searchTree: (...args: unknown[]) => searchTree(...args),
    listPinnedPanelIds: (...args: unknown[]) => listPinnedPanelIds(...args),
    getPresentation: (...args: unknown[]) => getPresentation(...args),
    getPresentations: (panelIds: string[]) => getPresentations(panelIds),
  },
  account: {
    getProfile: () => getProfile(),
    resolveProfiles: vi.fn(() => Promise.resolve({})),
  },
  workspace: {},
}));

// Capture the `panel-tree-invalidated` handler so a test can push a fresh snapshot.
let treeUpdateHandler: ((data: unknown) => void) | null = null;
let presentationChangeHandler: ((data: { revision: number; panelIds: string[] }) => void) | null =
  null;
vi.mock("../useShellEvent.js", () => ({
  useShellEvent: (event: string, handler: (data: unknown) => void) => {
    if (event === "panel-tree-invalidated") treeUpdateHandler = handler;
  },
}));
vi.mock("../useDirectShellEvent.js", () => ({
  useDirectShellEvent: (
    event: string,
    handler: (data: { revision: number; panelIds: string[] }) => void
  ) => {
    if (event === "panel-presentation-changed") presentationChangeHandler = handler;
  },
}));

import {
  flattenTree,
  PanelTreeProvider,
  type PanelTreeViewNode,
  useDescendantSiblingGroups,
  useFullPanel,
  usePanelTree,
  useRootPanels,
} from "./PanelTreeContext";
import { pinMutationSeqAtom, pinnedPanelIdsAtom } from "../../state/appModeAtoms";

type TestOwnerGroup = { ownerUserId: string | null; slotIds: string[] };
let currentGroups: TestOwnerGroup[] = [];
let childSlotIds = new Map<string, string[]>();

function setRootGroups(groups: TestOwnerGroup[]) {
  currentGroups = groups;
}

function PinProbe() {
  const pins = useAtomValue(pinnedPanelIdsAtom);
  return <div data-testid="pins">{[...pins].sort().join(",")}</div>;
}

function RootProbe() {
  const { panels, loading } = useRootPanels();
  const { refreshing, loadMoreRootGroups } = usePanelTree();
  return (
    <>
      <div
        data-testid="roots"
        data-loading={loading ? "true" : "false"}
        data-refreshing={refreshing ? "true" : "false"}
      >
        {panels.map((item) => item.id).join(",")}
      </div>
      <button type="button" onClick={() => void loadMoreRootGroups()}>
        More owners
      </button>
    </>
  );
}

function FullPanelProbe({ panelId }: { panelId: string }) {
  const { panel, loading } = useFullPanel(panelId);
  return (
    <div
      data-testid="full-panel"
      data-loading={loading ? "true" : "false"}
      data-hosted-runtime-entity-id={panel?.artifacts.hostedRuntimeEntityId ?? ""}
    >
      {panel ? `${panel.id}:${panel.artifacts.buildState}` : ""}
    </div>
  );
}

function DescendantProbe({ panelId }: { panelId: string }) {
  const { groups } = useDescendantSiblingGroups(panelId);
  return <div data-testid="descendant">{groups.map((group) => group.selectedId).join(",")}</div>;
}

function SelectionProbe({ panelId }: { panelId: string }) {
  const { panelMap } = usePanelTree();
  const renderCount = useRef(0);
  renderCount.current += 1;
  return (
    <div data-testid="selection" data-render-count={String(renderCount.current)}>
      {panelMap.get(panelId)?.selectedChildId ?? ""}
    </div>
  );
}

function ChildrenLoader({ panelId }: { panelId: string }) {
  const { loadChildren } = usePanelTree();
  useEffect(() => {
    void loadChildren(panelId);
  }, [loadChildren, panelId]);
  return null;
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

function emitInvalidation(revision: number) {
  act(() => {
    treeUpdateHandler?.({
      revision,
      reset: true,
      groups: [],
      changedSlotIds: [],
      removedSlotIds: [],
    });
  });
}

beforeEach(() => {
  treeUpdateHandler = null;
  presentationChangeHandler = null;
  currentGroups = [];
  childSlotIds = new Map();
  getRootGroups.mockReset();
  getRootGroups.mockImplementation(() =>
    Promise.resolve({
      revision: 1,
      groups: currentGroups.map((group) => ({
        ownerUserId: group.ownerUserId,
        rootCount: group.slotIds.length,
      })),
      nextCursor: null,
    })
  );
  getTreePage.mockReset();
  getTreePage.mockImplementation(
    ({
      group,
    }: {
      group: { kind: string; ownerUserId?: string | null; parentSlotId?: string };
    }) => {
      const slotIds =
        group.kind === "roots"
          ? (currentGroups.find((item) => item.ownerUserId === group.ownerUserId)?.slotIds ?? [])
          : (childSlotIds.get(group.parentSlotId ?? "") ?? []);
      return Promise.resolve({
        revision: 1,
        group,
        nodes: slotIds.map((slotId, index) => ({
          slotId,
          parentSlotId: group.kind === "children" ? (group.parentSlotId ?? null) : null,
          ownerUserId: group.ownerUserId ?? null,
          title: slotId,
          createdAt: slotIds.length - index,
          childCount: childSlotIds.get(slotId)?.length ?? 0,
        })),
        nextCursor: null,
      });
    }
  );
  getTreePath.mockReset();
  getTreePath.mockResolvedValue(null);
  searchTree.mockReset();
  searchTree.mockResolvedValue({ revision: 1, hits: [], nextCursor: null });
  listPinnedPanelIds.mockReset();
  getPresentation.mockReset();
  getPresentations.mockReset();
  getPresentations.mockImplementation((panelIds: string[]) =>
    Promise.all(panelIds.map((panelId) => getPresentation(panelId))).then((presentations) =>
      presentations.filter((presentation) => presentation != null)
    )
  );
  getProfile.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("flattenTree", () => {
  it("preserves resolved unit and browser icon presentation on sidebar rows", () => {
    const favicon = { pageUrl: "https://example.test/", updatedAt: 7 };
    const panel: PanelTreeViewNode = {
      id: "chat",
      title: "Agentic Chat",
      icon: "💬",
      source: "panels/chat",
      favicon,
      owner: null,
      parentId: null,
      childCount: 0,
      children: [],
      childrenLoaded: true,
      childrenLoadedCount: 0,
      childrenHasMore: false,
      selectedChildId: null,
    };

    expect(flattenTree([panel], new Set())[0]?.panel).toEqual({
      id: "chat",
      title: "Agentic Chat",
      icon: "💬",
      source: "panels/chat",
      favicon,
      childCount: 0,
      position: 0,
    });
  });
});

describe("useFullPanel local presentation", () => {
  it("never exposes the previous panel while a different panel is loading", async () => {
    const ready = (id: string) => ({
      id,
      title: id,
      buildKey: "b".repeat(64),
      parentId: null,
      position: 0,
      selectedChildId: null,
      children: [],
      snapshot: { source: "panels/ready", contextId: `context-${id}`, options: {} },
      artifacts: { buildState: "ready", htmlPath: `/${id}` },
      hostViewRevision: 1,
    });
    let resolveSecond!: (value: ReturnType<typeof ready>) => void;
    getPresentation.mockImplementation((panelId: string) =>
      panelId === "panel:tree/a"
        ? Promise.resolve(ready(panelId))
        : new Promise((resolve) => {
            resolveSecond = resolve;
          })
    );

    const { rerender } = render(<FullPanelProbe panelId="panel:tree/a" />);
    await waitFor(() =>
      expect(screen.getByTestId("full-panel").textContent).toBe("panel:tree/a:ready")
    );

    rerender(<FullPanelProbe panelId="panel:tree/b" />);

    expect(screen.getByTestId("full-panel").textContent).toBe("");
    expect(screen.getByTestId("full-panel").dataset["loading"]).toBe("true");

    resolveSecond(ready("panel:tree/b"));
    await waitFor(() =>
      expect(screen.getByTestId("full-panel").textContent).toBe("panel:tree/b:ready")
    );
  });

  it("renders the Electron host's terminal presentation projection", async () => {
    getPresentation.mockResolvedValue({
      id: "panel:tree/a",
      title: "Ready panel",
      buildKey: "b".repeat(64),
      parentId: null,
      position: 0,
      selectedChildId: null,
      children: [],
      snapshot: {
        source: "panels/ready",
        contextId: "context-a",
        options: { ref: "main" },
      },
      artifacts: {
        buildState: "ready",
        htmlPath: "http://localhost/panel",
      },
      hostViewRevision: 3,
    });
    render(<FullPanelProbe panelId="panel:tree/a" />);

    expect(screen.getByTestId("full-panel").dataset["loading"]).toBe("true");
    expect(getPresentation).toHaveBeenCalledWith("panel:tree/a");

    await waitFor(() =>
      expect(screen.getByTestId("full-panel").textContent).toBe("panel:tree/a:ready")
    );
    expect(screen.getByTestId("full-panel").dataset["loading"]).toBe("false");
  });

  it("applies a pushed local projection change while an earlier read is still building", async () => {
    const building = {
      id: "panel:tree/a",
      title: "Panel",
      buildKey: "b".repeat(64),
      parentId: null,
      position: 0,
      selectedChildId: null,
      children: [],
      snapshot: { source: "panels/ready", contextId: "context-a", options: {} },
      artifacts: { buildState: "building" },
      hostViewRevision: 2,
    };
    getPresentation
      .mockResolvedValueOnce(building)
      .mockResolvedValue({ ...building, artifacts: { buildState: "ready", htmlPath: "/ready" } });
    render(<FullPanelProbe panelId="panel:tree/a" />);
    await waitFor(() =>
      expect(screen.getByTestId("full-panel").textContent).toBe("panel:tree/a:building")
    );

    act(() => {
      presentationChangeHandler?.({ revision: 3, panelIds: ["panel:tree/a"] });
    });

    await waitFor(() =>
      expect(screen.getByTestId("full-panel").textContent).toBe("panel:tree/a:ready")
    );
  });

  it("rejoins durable presentation after a tree transition races the activation event", async () => {
    const preparing = {
      id: "panel:tree/a",
      title: "Panel",
      runtimeEntityId: "panel:nav-a",
      buildKey: null,
      parentId: null,
      position: 0,
      selectedChildId: null,
      children: [],
      snapshot: { source: "panels/ready", contextId: "context-a", options: {} },
      artifacts: { buildState: "pending", buildProgress: "Preparing panel runtime..." },
      hostViewRevision: 1,
    };
    getPresentation.mockResolvedValueOnce(preparing).mockResolvedValue({
      ...preparing,
      buildKey: "b".repeat(64),
      artifacts: {
        buildState: "ready",
        htmlPath: "/ready",
        hostedRuntimeEntityId: "panel:nav-a",
      },
      hostViewRevision: 2,
    });
    render(<FullPanelProbe panelId="panel:tree/a" />);
    await waitFor(() =>
      expect(screen.getByTestId("full-panel").textContent).toBe("panel:tree/a:pending")
    );

    act(() => {
      treeUpdateHandler?.({
        revision: 2,
        reset: true,
        groups: [],
        changedSlotIds: [],
        removedSlotIds: [],
      });
    });

    await waitFor(() =>
      expect(screen.getByTestId("full-panel").textContent).toBe("panel:tree/a:ready")
    );
    expect(getPresentation).toHaveBeenCalledTimes(2);
  });

  it("waits for projection events instead of polling a building panel", async () => {
    getPresentation.mockResolvedValue({
      id: "panel:tree/a",
      title: "Panel",
      buildKey: "b".repeat(64),
      parentId: null,
      position: 0,
      selectedChildId: null,
      children: [],
      snapshot: { source: "panels/ready", contextId: "context-a", options: {} },
      artifacts: { buildState: "building" },
      hostViewRevision: 2,
    });
    render(<FullPanelProbe panelId="panel:tree/a" />);
    await waitFor(() => expect(getPresentation).toHaveBeenCalledOnce());

    await new Promise((resolve) => setTimeout(resolve, 325));
    expect(getPresentation).toHaveBeenCalledOnce();
  });

  it("does not let an older ready projection erase the hosted runtime identity", async () => {
    const current = {
      id: "panel:tree/browser",
      title: "Browser",
      runtimeEntityId: "panel:nav-current",
      buildKey: null,
      parentId: null,
      position: 0,
      selectedChildId: null,
      children: [],
      snapshot: {
        source: "browser:https://example.test/",
        contextId: "context-browser",
        options: {},
      },
      artifacts: {
        buildState: "ready",
        htmlPath: "https://example.test/",
        hostedRuntimeEntityId: "panel:nav-current",
      },
      hostViewRevision: 2,
    };
    let resolveInitial!: (value: unknown) => void;
    getPresentation
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveInitial = resolve;
          })
      )
      .mockResolvedValue(current);

    render(<FullPanelProbe panelId="panel:tree/browser" />);
    await waitFor(() => expect(getPresentation).toHaveBeenCalledOnce());
    act(() => {
      presentationChangeHandler?.({ revision: 2, panelIds: ["panel:tree/browser"] });
    });
    await waitFor(() =>
      expect(screen.getByTestId("full-panel").dataset["hostedRuntimeEntityId"]).toBe(
        "panel:nav-current"
      )
    );

    await act(async () => {
      resolveInitial({
        ...current,
        artifacts: { buildState: "ready", htmlPath: "https://example.test/" },
        hostViewRevision: 1,
      });
    });
    expect(screen.getByTestId("full-panel").dataset["hostedRuntimeEntityId"]).toBe(
      "panel:nav-current"
    );
  });

  it("accepts a newer host view observed by an earlier overlapping request", async () => {
    const preparing = {
      id: "panel:tree/a",
      title: "Panel",
      runtimeEntityId: "panel:nav-a",
      buildKey: "b".repeat(64),
      parentId: null,
      position: 0,
      selectedChildId: null,
      children: [],
      snapshot: { source: "panels/ready", contextId: "context-a", options: {} },
      artifacts: { buildState: "pending", buildProgress: "Preparing panel runtime..." },
      hostViewRevision: 1,
    };
    const ready = {
      ...preparing,
      artifacts: {
        buildState: "ready",
        htmlPath: "/ready",
        hostedRuntimeEntityId: "panel:nav-a",
      },
      hostViewRevision: 2,
    };
    let resolveInitial!: (value: typeof ready) => void;
    let resolveRefresh!: (value: typeof preparing) => void;
    getPresentation
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveInitial = resolve;
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRefresh = resolve;
          })
      );

    render(<FullPanelProbe panelId="panel:tree/a" />);
    await waitFor(() => expect(getPresentation).toHaveBeenCalledOnce());
    act(() => {
      presentationChangeHandler?.({ revision: 2, panelIds: ["panel:tree/a"] });
    });
    await waitFor(() => expect(getPresentation).toHaveBeenCalledTimes(2));

    await act(async () => resolveRefresh(preparing));
    expect(screen.getByTestId("full-panel").textContent).toBe("panel:tree/a:pending");

    await act(async () => resolveInitial(ready));
    expect(screen.getByTestId("full-panel").textContent).toBe("panel:tree/a:ready");
    expect(screen.getByTestId("full-panel").dataset["hostedRuntimeEntityId"]).toBe(
      "panel:nav-a"
    );
  });
});

describe("PanelTreeProvider pin reconciliation", () => {
  it("seeds the pin atom from listPinnedPanelIds on the initial snapshot", async () => {
    listPinnedPanelIds.mockResolvedValue(["panel:tree/a"]);
    setRootGroups([{ ownerUserId: "alice", slotIds: ["panel:tree/a"] }]);

    renderProvider();

    await waitFor(() => expect(screen.getByTestId("pins").textContent).toBe("panel:tree/a"));
    expect(screen.getByTestId("roots").dataset["loading"]).toBe("false");
  });

  it("re-seeds on every tree update so a reused slot id drops its stale pin", async () => {
    // Initial: panel x is loaded and pinned.
    listPinnedPanelIds.mockResolvedValueOnce(["panel:tree/x"]);
    setRootGroups([{ ownerUserId: "alice", slotIds: ["panel:tree/x"] }]);

    renderProvider();
    await waitFor(() => expect(screen.getByTestId("pins").textContent).toBe("panel:tree/x"));

    // A later snapshot (x removed, a new panel under a *reused* slot id appears).
    // The main process is the source of truth and now reports no pins → the
    // atom must reconcile to empty rather than keep the stale 📌.
    listPinnedPanelIds.mockResolvedValue([]);
    setRootGroups([{ ownerUserId: "alice", slotIds: ["panel:tree/y"] }]);
    emitInvalidation(2);

    await waitFor(() => expect(screen.getByTestId("pins").textContent).toBe(""));
  });

  it("discards a reconcile response superseded by a local toggle (no clobber)", async () => {
    listPinnedPanelIds.mockResolvedValueOnce([]); // mount reconcile → empty
    setRootGroups([{ ownerUserId: "alice", slotIds: ["panel:tree/x"] }]);
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
    emitInvalidation(2);
    await waitFor(() => expect(listPinnedPanelIds).toHaveBeenCalledTimes(2));

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

  it("loads bounded owner groups and root pages on mount after account attach", async () => {
    listPinnedPanelIds.mockResolvedValue([]);
    setRootGroups([{ ownerUserId: "alice", slotIds: ["panel:tree/a"] }]);

    renderProvider();

    await waitFor(() => expect(screen.getByTestId("roots").textContent).toBe("panel:tree/a"));
    expect(screen.getByTestId("roots").dataset["loading"]).toBe("false");
    expect(getRootGroups).toHaveBeenCalledOnce();
    expect(getTreePage).toHaveBeenCalledOnce();
    expect(listPinnedPanelIds).toHaveBeenCalled();
  });

  it("orders the verified account's owner group before other members", async () => {
    listPinnedPanelIds.mockResolvedValue([]);
    setRootGroups([
      { ownerUserId: "bob", slotIds: ["bob-root"] },
      { ownerUserId: "alice", slotIds: ["alice-root"] },
    ]);
    renderProvider();

    await waitFor(() =>
      expect(screen.getByTestId("roots").textContent).toBe("alice-root,bob-root")
    );
  });

  it("hydrates root pages for owner groups discovered after the first page", async () => {
    listPinnedPanelIds.mockResolvedValue([]);
    getRootGroups
      .mockResolvedValueOnce({
        revision: 1,
        groups: [{ ownerUserId: "alice", rootCount: 1 }],
        nextCursor: "owners:page-2",
      })
      .mockResolvedValueOnce({
        revision: 1,
        groups: [{ ownerUserId: "bob", rootCount: 1 }],
        nextCursor: null,
      });
    getTreePage.mockImplementation(
      ({ group }: { group: { kind: string; ownerUserId?: string | null } }) =>
        Promise.resolve({
          revision: 1,
          group,
          nodes:
            group.kind === "roots"
              ? [
                  {
                    slotId: `${group.ownerUserId}-root`,
                    parentSlotId: null,
                    ownerUserId: group.ownerUserId ?? null,
                    title: `${group.ownerUserId}-root`,
                    createdAt: 1,
                    childCount: 0,
                  },
                ]
              : [],
          nextCursor: null,
        })
    );

    renderProvider();
    await waitFor(() => expect(screen.getByTestId("roots").textContent).toBe("alice-root"));

    fireEvent.click(screen.getByRole("button", { name: "More owners" }));

    await waitFor(() =>
      expect(screen.getByTestId("roots").textContent).toBe("alice-root,bob-root")
    );
    expect(getTreePage).toHaveBeenCalledWith(
      expect.objectContaining({
        group: { kind: "roots", ownerUserId: "bob" },
      })
    );
  });

  it("publishes refresh state synchronously with cache invalidation", async () => {
    listPinnedPanelIds.mockResolvedValue([]);
    setRootGroups([{ ownerUserId: "alice", slotIds: ["panel:tree/x"] }]);
    renderProvider();
    await waitFor(() => expect(screen.getByTestId("roots").textContent).toBe("panel:tree/x"));

    let resolveGroups: (value: {
      revision: number;
      groups: Array<{ ownerUserId: string | null; rootCount: number }>;
      nextCursor: null;
    }) => void = () => {};
    getRootGroups.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveGroups = resolve;
        })
    );
    setRootGroups([{ ownerUserId: "alice", slotIds: ["panel:tree/y"] }]);
    emitInvalidation(2);

    expect(screen.getByTestId("roots").dataset["refreshing"]).toBe("true");
    await waitFor(() => expect(getRootGroups).toHaveBeenCalledTimes(2));

    await act(async () => {
      resolveGroups({
        revision: 2,
        groups: [{ ownerUserId: "alice", rootCount: 1 }],
        nextCursor: null,
      });
    });
    await waitFor(() => expect(screen.getByTestId("roots").textContent).toBe("panel:tree/y"));
    expect(screen.getByTestId("roots").dataset["refreshing"]).toBe("false");
  });
});

describe("PanelTreeProvider local descendant selection", () => {
  it("uses the host-selected child and updates it without reloading the semantic tree", async () => {
    listPinnedPanelIds.mockResolvedValue([]);
    setRootGroups([{ ownerUserId: "alice", slotIds: ["panel:root"] }]);
    childSlotIds.set("panel:root", ["panel:first", "panel:selected"]);
    getPresentation.mockResolvedValue({
      id: "panel:root",
      selectedChildId: "panel:selected",
    });

    render(
      <PanelTreeProvider>
        <DescendantProbe panelId="panel:root" />
      </PanelTreeProvider>
    );

    await waitFor(() =>
      expect(screen.getByTestId("descendant").textContent).toBe("panel:selected")
    );
    getPresentation.mockResolvedValue({
      id: "panel:root",
      selectedChildId: "panel:first",
    });
    act(() => {
      presentationChangeHandler?.({ revision: 2, panelIds: ["panel:root"] });
    });
    await waitFor(() => expect(screen.getByTestId("descendant").textContent).toBe("panel:first"));
  });

  it("applies only the newest presentation revision and skips no-op selections", async () => {
    listPinnedPanelIds.mockResolvedValue([]);
    setRootGroups([{ ownerUserId: "alice", slotIds: ["panel:root"] }]);
    childSlotIds.set("panel:root", ["panel:first", "panel:selected"]);

    render(
      <PanelTreeProvider>
        <ChildrenLoader panelId="panel:root" />
        <SelectionProbe panelId="panel:root" />
      </PanelTreeProvider>
    );

    await waitFor(() => expect(screen.getByTestId("selection").textContent).toBe("panel:first"));

    getPresentation.mockReset();
    let resolveOlder!: (value: unknown) => void;
    const olderResponse = new Promise((resolve) => {
      resolveOlder = resolve;
    });
    getPresentation
      .mockImplementationOnce(() => olderResponse)
      .mockResolvedValueOnce({ id: "panel:root", selectedChildId: "panel:selected" });

    act(() => {
      presentationChangeHandler?.({ revision: 3, panelIds: ["panel:root"] });
      presentationChangeHandler?.({ revision: 4, panelIds: ["panel:root"] });
      presentationChangeHandler?.({ revision: 2, panelIds: ["panel:root"] });
    });

    await waitFor(() => expect(screen.getByTestId("selection").textContent).toBe("panel:selected"));
    expect(getPresentation).toHaveBeenCalledTimes(2);

    await act(async () => {
      resolveOlder({ id: "panel:root", selectedChildId: "panel:first" });
      await olderResponse;
    });
    expect(screen.getByTestId("selection").textContent).toBe("panel:selected");

    const renderCount = screen.getByTestId("selection").dataset["renderCount"];
    getPresentation.mockResolvedValue({ id: "panel:root", selectedChildId: "panel:selected" });
    act(() => {
      presentationChangeHandler?.({ revision: 5, panelIds: ["panel:root"] });
    });
    await waitFor(() => expect(getPresentation).toHaveBeenCalledTimes(3));
    expect(screen.getByTestId("selection").dataset["renderCount"]).toBe(renderCount);
  });

  it("does not discard one panel update when a different panel changes later", async () => {
    listPinnedPanelIds.mockResolvedValue([]);
    setRootGroups([{ ownerUserId: "alice", slotIds: ["panel:a", "panel:b"] }]);
    childSlotIds.set("panel:a", ["panel:a-old", "panel:a-new"]);
    childSlotIds.set("panel:b", ["panel:b-old", "panel:b-new"]);
    getPresentation.mockImplementation((panelId: string) =>
      Promise.resolve({ id: panelId, selectedChildId: `${panelId}-old` })
    );

    render(
      <PanelTreeProvider>
        <ChildrenLoader panelId="panel:a" />
        <ChildrenLoader panelId="panel:b" />
        <SelectionProbe panelId="panel:a" />
        <SelectionProbe panelId="panel:b" />
      </PanelTreeProvider>
    );
    await waitFor(() => {
      expect(screen.getAllByTestId("selection").map((node) => node.textContent)).toEqual([
        "panel:a-old",
        "panel:b-old",
      ]);
    });

    getPresentations.mockClear();
    let resolveA!: (value: Array<{ id: string; selectedChildId: string }>) => void;
    let resolveB!: (value: Array<{ id: string; selectedChildId: string }>) => void;
    getPresentations
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveA = resolve;
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveB = resolve;
          })
      );

    act(() => {
      presentationChangeHandler?.({ revision: 3, panelIds: ["panel:a"] });
      presentationChangeHandler?.({ revision: 4, panelIds: ["panel:b"] });
    });
    await waitFor(() => expect(getPresentations).toHaveBeenCalledTimes(2));

    await act(async () => {
      resolveB([{ id: "panel:b", selectedChildId: "panel:b-new" }]);
    });
    await act(async () => {
      resolveA([{ id: "panel:a", selectedChildId: "panel:a-new" }]);
    });

    expect(screen.getAllByTestId("selection").map((node) => node.textContent)).toEqual([
      "panel:a-new",
      "panel:b-new",
    ]);
  });
});

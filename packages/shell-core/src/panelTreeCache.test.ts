import { describe, expect, it, vi } from "vitest";
import { PanelTreeCache, type PanelTreeQuerySource } from "./panelTreeCache";

function source(): PanelTreeQuerySource {
  return {
    rootGroups: vi.fn(),
    page: vi.fn(async ({ group, cursor }) => ({
      revision: 1,
      group,
      nodes: [
        {
          slotId: (cursor ? "older" : "newer") as never,
          parentSlotId: null,
          ownerUserId: "user",
          title: cursor ? "Older" : "Newer",
          createdAt: cursor ? 1 : 2,
          childCount: 0,
        },
      ],
      nextCursor: cursor ? null : "next",
    })),
    path: vi.fn(async () => null),
    search: vi.fn(),
  };
}

describe("PanelTreeCache", () => {
  it("pages without replacing already loaded newer siblings", async () => {
    const cache = new PanelTreeCache(source());
    const group = { kind: "roots" as const, ownerUserId: "user" };
    await cache.loadFirst(group);
    await cache.loadMore(group);
    expect(cache.getGroup(group)?.nodes.map((node) => node.slotId)).toEqual(["newer", "older"]);
  });

  it("slides a sibling window into older history instead of retaining every loaded page", async () => {
    const querySource = source();
    vi.mocked(querySource.page).mockImplementation(async ({ group, cursor }) => {
      const start = cursor ? Number(cursor) : 0;
      return {
        revision: 1,
        group,
        nodes: Array.from({ length: 2 }, (_, offset) => ({
          slotId: `slot-${start + offset}`,
          parentSlotId: null,
          ownerUserId: "user",
          title: `Slot ${start + offset}`,
          createdAt: 10 - start - offset,
          childCount: 0,
        })),
        nextCursor: start >= 4 ? null : String(start + 2),
      };
    });
    const cache = new PanelTreeCache(querySource, { maxNodesPerGroup: 3 });
    const group = { kind: "roots" as const, ownerUserId: "user" };

    await cache.loadFirst(group);
    await cache.loadMore(group);
    expect(cache.getGroup(group)?.nodes.map((node) => node.slotId)).toEqual([
      "slot-1",
      "slot-2",
      "slot-3",
    ]);
    await cache.loadMore(group);
    expect(cache.getGroup(group)?.nodes.map((node) => node.slotId)).toEqual([
      "slot-3",
      "slot-4",
      "slot-5",
    ]);
  });

  it("retains the last coherent query result across a revision gap", async () => {
    const querySource = source();
    const cache = new PanelTreeCache(querySource);
    const group = { kind: "roots" as const, ownerUserId: "user" };
    await cache.loadFirst(group);
    const invalidatedGroups = cache.invalidate({
      revision: 3,
      reset: false,
      groups: [],
      changedSlotIds: [],
      removedSlotIds: [],
    });
    expect(invalidatedGroups).toEqual([group]);
    expect(cache.getGroup(group)?.nodes.map((node) => node.slotId)).toEqual(["newer"]);

    vi.mocked(querySource.page).mockResolvedValueOnce({
      revision: 3,
      group,
      nodes: [
        {
          slotId: "replacement",
          parentSlotId: null,
          ownerUserId: "user",
          title: "Replacement",
          createdAt: 3,
          childCount: 0,
        },
      ],
      nextCursor: null,
    });
    await cache.loadFirst(group);
    expect(cache.getGroup(group)?.nodes.map((node) => node.slotId)).toEqual(["replacement"]);
  });

  it("returns every loaded sibling page for revalidation after a reset", async () => {
    const querySource = source();
    const cache = new PanelTreeCache(querySource);
    const roots = { kind: "roots" as const, ownerUserId: "user" };
    const children = { kind: "children" as const, parentSlotId: "parent" };
    await cache.loadFirst(roots);
    await cache.loadFirst(children);

    const invalidatedGroups = cache.invalidate({
      revision: 2,
      reset: true,
      groups: [],
      changedSlotIds: [],
      removedSlotIds: [],
    });

    expect(invalidatedGroups).toEqual([roots, children]);
    expect(cache.getGroup(children)?.nodes).toHaveLength(1);

    vi.mocked(querySource.page).mockResolvedValueOnce({
      revision: 2,
      group: children,
      nodes: [
        {
          slotId: "new-child",
          parentSlotId: "parent",
          ownerUserId: "user",
          title: "New child",
          createdAt: 3,
          childCount: 0,
        },
      ],
      nextCursor: null,
    });
    await cache.loadFirst(children);
    expect(cache.getGroup(children)?.nodes.map((node) => node.slotId)).toEqual(["new-child"]);
  });

  it("starts the current-generation query while an invalidated query is still in flight", async () => {
    const group = { kind: "roots" as const, ownerUserId: "user" };
    let resolveStale!: (page: Awaited<ReturnType<PanelTreeQuerySource["page"]>>) => void;
    const stale = new Promise<Awaited<ReturnType<PanelTreeQuerySource["page"]>>>((resolve) => {
      resolveStale = resolve;
    });
    const querySource = source();
    vi.mocked(querySource.page)
      .mockReturnValueOnce(stale)
      .mockResolvedValueOnce({
        revision: 2,
        group,
        nodes: [
          {
            slotId: "current",
            parentSlotId: null,
            ownerUserId: "user",
            title: "Current",
            createdAt: 2,
            childCount: 0,
          },
        ],
        nextCursor: null,
      });
    const cache = new PanelTreeCache(querySource);

    const staleLoad = cache.loadFirst(group);
    cache.invalidate({
      revision: 2,
      reset: false,
      groups: [],
      changedSlotIds: ["current" as never],
      removedSlotIds: [],
    });
    await cache.loadFirst(group);
    resolveStale({
      revision: 1,
      group,
      nodes: [
        {
          slotId: "stale",
          parentSlotId: null,
          ownerUserId: "user",
          title: "Stale",
          createdAt: 1,
          childCount: 0,
        },
      ],
      nextCursor: null,
    });
    await staleLoad;

    expect(querySource.page).toHaveBeenCalledTimes(2);
    expect(cache.getGroup(group)?.nodes.map((node) => node.slotId)).toEqual(["current"]);
    expect(cache.getGroup(group)?.loading).toBe(false);
  });

  it("restarts a sibling query when the revision changes between pages", async () => {
    let revision = 1;
    const querySource = source();
    const page = vi.mocked(querySource.page);
    page.mockImplementation(async ({ group, cursor }) => ({
      revision,
      group,
      nodes: [
        {
          slotId: cursor ? "stale-older" : `head-${revision}`,
          parentSlotId: null,
          ownerUserId: "user",
          title: "Panel",
          createdAt: revision,
          childCount: 0,
        },
      ],
      nextCursor: cursor ? null : "next",
    }));
    const cache = new PanelTreeCache(querySource);
    const group = { kind: "roots" as const, ownerUserId: "user" };
    await cache.loadFirst(group);
    revision = 2;

    await cache.loadMore(group);

    expect(cache.getGroup(group)?.nodes.map((node) => node.slotId)).toEqual(["head-2"]);
    expect(page).toHaveBeenCalledTimes(3);
  });

  it("prefers evicting collapsed groups but never lets retention defeat the memory bound", async () => {
    const querySource = source();
    const cache = new PanelTreeCache(querySource, { maxGroups: 2, maxNodes: 2 });
    const first = { kind: "children" as const, parentSlotId: "first" };
    const visible = { kind: "children" as const, parentSlotId: "visible" };
    const newest = { kind: "children" as const, parentSlotId: "newest" };

    await cache.loadFirst(first);
    await cache.loadFirst(visible);
    cache.retainGroups([visible]);
    await cache.loadFirst(newest);

    expect(cache.getGroup(first)).toBeNull();
    expect(cache.getGroup(visible)).not.toBeNull();
    expect(cache.getGroup(newest)).not.toBeNull();

    cache.retainGroups([visible, newest]);
    const fourth = { kind: "children" as const, parentSlotId: "fourth" };
    await cache.loadFirst(fourth);

    const loadedCount = [visible, newest, fourth].filter((group) => cache.getGroup(group)).length;
    expect(loadedCount).toBe(2);
  });

  it("caps accumulated root-owner groups", async () => {
    const querySource = source();
    vi.mocked(querySource.rootGroups).mockImplementation(async ({ cursor }) => ({
      revision: 1,
      groups: Array.from({ length: 2 }, (_, index) => ({
        ownerUserId: `${cursor ?? "head"}-${index}`,
        rootCount: 1,
      })),
      nextCursor: cursor ? null : "older",
    }));
    const cache = new PanelTreeCache(querySource, { maxRootGroups: 3, pageSize: 2 });

    await cache.loadRootGroups();
    await cache.loadRootGroups();

    expect(cache.getRootGroups().groups).toHaveLength(3);
    expect(cache.getRootGroups().nextCursor).toBeNull();
  });

  it("does not retain an addressed path larger than the path-node budget", async () => {
    const querySource = source();
    vi.mocked(querySource.path).mockResolvedValue({
      revision: 1,
      nodes: Array.from({ length: 3 }, (_, index) => ({
        slotId: `path-${index}`,
        parentSlotId: index === 0 ? null : `path-${index - 1}`,
        ownerUserId: "user",
        title: `Path ${index}`,
        createdAt: index,
        childCount: index === 2 ? 0 : 1,
      })),
    });
    const cache = new PanelTreeCache(querySource, { maxPathNodes: 2 });

    await expect(cache.loadPath("path-2")).resolves.toMatchObject({ revision: 1 });
    await cache.loadPath("path-2");

    expect(querySource.path).toHaveBeenCalledTimes(2);
  });
});

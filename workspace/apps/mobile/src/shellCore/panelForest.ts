export interface MobilePanelTreeNode {
  id: string;
  title: string;
  parentId: string | null;
  owner: string | null;
  icon?: string;
  source?: string;
  kind?: "workspace" | "browser";
  childCount: number;
  childrenLoadedCount?: number;
  childrenHaveMore?: boolean;
  children: MobilePanelTreeNode[];
}

export interface MobilePanelTreeGroup {
  owner: string;
  rootCount: number;
  rootLoadedCount?: number;
  rootsHaveMore?: boolean;
  rootPanels: MobilePanelTreeNode[];
}

export interface MobileOwnerProfile {
  userId: string;
  handle: string;
  displayName: string;
  color?: string;
  revoked?: boolean;
}

export type MobilePanelForestRow =
  | { kind: "owner"; owner: string; label: string; color?: string }
  | {
      kind: "panel";
      panel: MobilePanelTreeNode;
      depth: number;
      isCollapsed: boolean;
    }
  | {
      kind: "load-more";
      groupKey: string;
      parentSlotId: string | null;
      ownerUserId?: string | null;
      depth: number;
      remaining: number;
    };

export function orderMobilePanelForest(
  groups: readonly MobilePanelTreeGroup[],
  selfUserId: string | null
): MobilePanelTreeGroup[] {
  if (!selfUserId) return [...groups];
  return [
    ...groups.filter((group) => group.owner === selfUserId),
    ...groups.filter((group) => group.owner !== selfUserId),
  ];
}

function ownerLabel(
  owner: string,
  selfUserId: string | null,
  profile: MobileOwnerProfile | undefined
): string {
  if (!owner) return "Workspace panels";
  if (owner === selfUserId) return "Your panels";
  if (profile) {
    const label = profile.displayName || `@${profile.handle}`;
    return profile.revoked ? `${label} (revoked)` : label;
  }
  return `Member ${owner.length > 10 ? `${owner.slice(0, 6)}…${owner.slice(-4)}` : owner}`;
}

function appendNodes(
  nodes: readonly MobilePanelTreeNode[],
  totalCount: number,
  loadedCount: number,
  hasMore: boolean,
  collapsedIds: ReadonlySet<string>,
  depth: number,
  rows: MobilePanelForestRow[],
  groupKey: string,
  parentSlotId: string | null,
  ownerUserId?: string | null
): void {
  for (const panel of nodes) {
    const isCollapsed = collapsedIds.has(panel.id);
    rows.push({ kind: "panel", panel, depth, isCollapsed });
    if (!isCollapsed && panel.childCount > 0) {
      appendNodes(
        panel.children,
        panel.childCount,
        panel.childrenLoadedCount ?? panel.children.length,
        panel.childrenHaveMore ?? panel.children.length < panel.childCount,
        collapsedIds,
        depth + 1,
        rows,
        `children:${panel.id}`,
        panel.id
      );
    }
  }
  if (hasMore) {
    rows.push({
      kind: "load-more",
      groupKey,
      parentSlotId,
      ...(ownerUserId !== undefined ? { ownerUserId } : {}),
      depth,
      remaining: Math.max(0, totalCount - loadedCount),
    });
  }
}

export function buildMobilePanelForestRows(
  groups: readonly MobilePanelTreeGroup[],
  collapsedIds: ReadonlySet<string>,
  selfUserId: string | null,
  profiles: ReadonlyMap<string, MobileOwnerProfile>
): MobilePanelForestRow[] {
  const rows: MobilePanelForestRow[] = [];
  for (const group of orderMobilePanelForest(groups, selfUserId)) {
    if (group.rootCount === 0) continue;
    const profile = profiles.get(group.owner);
    rows.push({
      kind: "owner",
      owner: group.owner,
      label: ownerLabel(group.owner, selfUserId, profile),
      ...(profile?.color ? { color: profile.color } : {}),
    });
    appendNodes(
      group.rootPanels,
      group.rootCount,
      group.rootLoadedCount ?? group.rootPanels.length,
      group.rootsHaveMore ?? group.rootPanels.length < group.rootCount,
      collapsedIds,
      0,
      rows,
      `roots:${group.owner}`,
      null,
      group.owner || null
    );
  }
  return rows;
}

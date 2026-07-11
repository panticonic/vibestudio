import type { Panel, PanelTreeSnapshot } from "@vibestudio/shared/types";

export type MobilePanelForestGroup = PanelTreeSnapshot["forest"][number];

export interface MobileOwnerProfile {
  userId: string;
  handle: string;
  displayName: string;
  color?: string;
  revoked?: boolean;
}

export type MobilePanelForestRow =
  | {
      kind: "owner";
      owner: string;
      label: string;
      color?: string;
    }
  | {
      kind: "panel";
      panel: Panel;
      depth: number;
      isCollapsed: boolean;
    };

export function orderMobilePanelForest(
  forest: readonly MobilePanelForestGroup[],
  selfUserId: string | null
): MobilePanelForestGroup[] {
  if (!selfUserId) return [...forest];
  const own = forest.filter((group) => group.owner === selfUserId);
  return own.length === 0
    ? [...forest]
    : [...own, ...forest.filter((group) => group.owner !== selfUserId)];
}

export function mobilePanelRoots(forest: readonly MobilePanelForestGroup[]): Panel[] {
  return forest.flatMap((group) => group.rootPanels);
}

export function preferredMobileRoot(
  forest: readonly MobilePanelForestGroup[],
  selfUserId: string | null
): Panel | null {
  return (
    orderMobilePanelForest(forest, selfUserId).find((group) => group.rootPanels.length > 0)
      ?.rootPanels[0] ?? null
  );
}

function ownerLabel(
  owner: string,
  selfUserId: string | null,
  profile: MobileOwnerProfile | undefined
): string {
  if (owner === "") return "Workspace panels";
  if (owner === selfUserId) return "Your panels";
  if (profile) {
    const label = profile.displayName || `@${profile.handle}`;
    return profile.revoked ? `${label} (revoked)` : label;
  }
  const suffix = owner.length > 10 ? `${owner.slice(0, 6)}…${owner.slice(-4)}` : owner;
  return `Member ${suffix}`;
}

function flattenGroup(
  panels: readonly Panel[],
  collapsedIds: ReadonlySet<string>,
  depth: number,
  rows: MobilePanelForestRow[]
): void {
  for (const panel of panels) {
    const isCollapsed = collapsedIds.has(panel.id);
    rows.push({ kind: "panel", panel, depth, isCollapsed });
    if (!isCollapsed) flattenGroup(panel.children, collapsedIds, depth + 1, rows);
  }
}

export function buildMobilePanelForestRows(
  forest: readonly MobilePanelForestGroup[],
  collapsedIds: ReadonlySet<string>,
  selfUserId: string | null,
  profiles: ReadonlyMap<string, MobileOwnerProfile>
): MobilePanelForestRow[] {
  const rows: MobilePanelForestRow[] = [];
  for (const group of orderMobilePanelForest(forest, selfUserId)) {
    if (group.rootPanels.length === 0) continue;
    const profile = profiles.get(group.owner);
    rows.push({
      kind: "owner",
      owner: group.owner,
      label: ownerLabel(group.owner, selfUserId, profile),
      ...(profile?.color ? { color: profile.color } : {}),
    });
    flattenGroup(group.rootPanels, collapsedIds, 0, rows);
  }
  return rows;
}

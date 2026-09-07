import { rpcDestinationKey, type RpcDestination } from "@vibestudio/rpc";

/** Presentation only: authority and decision handlers remain with the RPC owner. */
export interface ApprovalPresentationItem {
  owner: RpcDestination;
  approvalId: string;
  actionable: boolean;
}

export interface ApprovalPresentationState {
  selectedKey: string | null;
  open: boolean;
  actionableKeys: ReadonlySet<string>;
}

export function approvalPresentationKey(
  item: Pick<ApprovalPresentationItem, "owner" | "approvalId">
): string {
  return JSON.stringify([rpcDestinationKey(item.owner), item.approvalId]);
}

export function createApprovalPresentationState(): ApprovalPresentationState {
  return { selectedKey: null, open: false, actionableKeys: new Set() };
}

export function reconcileApprovalPresentation(
  state: ApprovalPresentationState,
  items: readonly ApprovalPresentationItem[]
): ApprovalPresentationState {
  const actionableKeys = new Set(
    items.filter((item) => item.actionable).map(approvalPresentationKey)
  );
  const newlyActionable = [...actionableKeys].some((key) => !state.actionableKeys.has(key));
  const selected = items.find((item) => approvalPresentationKey(item) === state.selectedKey);
  const selectedKey =
    selected && (selected.actionable || !newlyActionable)
      ? state.selectedKey
      : items.length
        ? approvalPresentationKey(items.find((item) => item.actionable) ?? items[0]!)
        : null;
  const open = selectedKey !== null && (state.open || newlyActionable);
  return selectedKey === state.selectedKey &&
    open === state.open &&
    actionableKeys.size === state.actionableKeys.size &&
    [...actionableKeys].every((key) => state.actionableKeys.has(key))
    ? state
    : { selectedKey, open, actionableKeys };
}

export function selectApprovalPresentation(
  state: ApprovalPresentationState,
  items: readonly ApprovalPresentationItem[],
  key: string
): ApprovalPresentationState {
  return items.some((item) => approvalPresentationKey(item) === key)
    ? { ...state, selectedKey: key, open: true }
    : state;
}

export function stepApprovalPresentation(
  state: ApprovalPresentationState,
  items: readonly ApprovalPresentationItem[],
  delta: number
): ApprovalPresentationState {
  if (!items.length) return state;
  const current = Math.max(
    0,
    items.findIndex((item) => approvalPresentationKey(item) === state.selectedKey)
  );
  const next = Math.max(0, Math.min(items.length - 1, current + delta));
  return selectApprovalPresentation(state, items, approvalPresentationKey(items[next]!));
}

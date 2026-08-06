import type { ApprovalDecisionId } from "@vibestudio/shared/approvalContract";
import type { PendingApproval } from "@vibestudio/shared/approvals";
import { getInstallReviewActionCopy } from "@vibestudio/shared/approvalCopy";
import {
  clearableRows,
  type InstallReviewPart,
  type TemplateInstallResolution,
} from "@vibestudio/shared/authority/unitInstallReview";
import {
  installAcceptanceFrom,
  selectedRowKeys,
  type InstallSelection,
} from "../ui/ApprovalsOverlay.js";
import type { NavKey } from "./inputRouter.js";

export type PendingUnitInstallReviewApproval = Extract<
  PendingApproval,
  { kind: "unit-install-review" }
>;

/**
 * The host's cursor into a `unit-install-review` approval: which part is
 * focused, whether that part is expanded into its individual permission
 * rows, which row is focused there, and the per-part/per-permission
 * selection built so far. `selection` stays `undefined` until the user
 * changes something — `installAcceptanceFrom` already knows that means the
 * platform's own default acceptance (§8), so there is nothing to seed here.
 */
export interface InstallReviewNavState {
  partIndex: number;
  rowExpanded: boolean;
  rowIndex: number;
  selection: InstallSelection | undefined;
}

/** The state a freshly-focused install review starts in. */
export const INITIAL_INSTALL_REVIEW_NAV: InstallReviewNavState = {
  partIndex: 0,
  rowExpanded: false,
  rowIndex: 0,
  selection: undefined,
};

function focusedPart(
  parts: readonly InstallReviewPart[],
  partIndex: number
): InstallReviewPart | undefined {
  if (parts.length === 0) return undefined;
  return parts[Math.min(Math.max(partIndex, 0), parts.length - 1)];
}

/** Every part's effective cleared set, materialized so a toggle can edit one part without losing another's default. */
function materializeSelection(
  parts: readonly InstallReviewPart[],
  selection: InstallSelection | undefined
): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const part of parts) {
    map.set(part.identityKey, new Set(selectedRowKeys(part, selection)));
  }
  return map;
}

function isSpace(nav: NavKey): boolean {
  return typeof nav === "object" && nav !== null && "char" in nav && nav.char === " ";
}

/**
 * The part/permission navigation this review offers on top of ↑/↓, which
 * keeps moving between approvals unchanged (§7.8, §U5):
 *
 * - ←/→ moves part focus, or — once a part is expanded — moves between that
 *   part's clearable rows;
 * - ⇥ expands or collapses the focused part into its individual rows, since
 *   §7.2's per-permission choice is the finer half of selection;
 * - space toggles whichever is focused: a part toggle sets or clears every
 *   clearable row it offers (U5's "allow this now" vs. "ask me when it's
 *   needed" applied to the whole part at once), a row toggle sets just that
 *   one.
 *
 * Any other key returns `state` unchanged, so a caller can gate this reducer
 * behind "is the current approval a `unit-install-review`" and fall through
 * to whatever else the key means for every other approval kind.
 */
export function applyInstallReviewNav(
  state: InstallReviewNavState,
  nav: NavKey,
  parts: readonly InstallReviewPart[]
): InstallReviewNavState {
  if (nav === "left" || nav === "right") {
    const delta = nav === "left" ? -1 : 1;
    if (state.rowExpanded) {
      const part = focusedPart(parts, state.partIndex);
      const rows = part ? clearableRows(part) : [];
      if (rows.length === 0) return state;
      return { ...state, rowIndex: (state.rowIndex + delta + rows.length) % rows.length };
    }
    if (parts.length === 0) return state;
    return {
      ...state,
      partIndex: (state.partIndex + delta + parts.length) % parts.length,
      rowExpanded: false,
      rowIndex: 0,
    };
  }

  if (nav === "tab") {
    const part = focusedPart(parts, state.partIndex);
    const rows = part ? clearableRows(part) : [];
    if (rows.length === 0) return state; // Nothing to drill into — a checkbox that would promise nothing.
    return { ...state, rowExpanded: !state.rowExpanded, rowIndex: 0 };
  }

  if (isSpace(nav)) {
    const part = focusedPart(parts, state.partIndex);
    if (!part) return state;
    const map = materializeSelection(parts, state.selection);
    if (state.rowExpanded) {
      const rows = clearableRows(part);
      const row = rows[Math.min(state.rowIndex, rows.length - 1)];
      if (!row) return state;
      const current = new Set(map.get(part.identityKey) ?? new Set<string>());
      if (current.has(row.key)) current.delete(row.key);
      else current.add(row.key);
      map.set(part.identityKey, current);
    } else {
      const clearable = clearableRows(part);
      const current = map.get(part.identityKey) ?? new Set<string>();
      const allSelected = clearable.length > 0 && clearable.every((row) => current.has(row.key));
      map.set(part.identityKey, allSelected ? new Set() : new Set(clearable.map((row) => row.key)));
    }
    return { ...state, selection: map };
  }

  return state;
}

/** Whether a nav key is one this reducer acts on — the gate a host checks before applying it. */
export function isInstallReviewNavKey(nav: NavKey): boolean {
  return nav === "left" || nav === "right" || nav === "tab" || isSpace(nav);
}

/** The clearable row the host has expanded the focused part into, for highlighting and hints. */
export function focusedRowKeyOf(
  state: InstallReviewNavState,
  parts: readonly InstallReviewPart[]
): string | undefined {
  if (!state.rowExpanded) return undefined;
  const part = focusedPart(parts, state.partIndex);
  const rows = part ? clearableRows(part) : [];
  return rows[Math.min(state.rowIndex, rows.length - 1)]?.key;
}

/**
 * The digit resolution for a `unit-install-review` (§8): `1` accepts with
 * the selection built so far — falling back to the platform's default when
 * nothing was touched — and `4` declines, genuinely `cancel` (§7.9), which
 * leaves the workspace untouched and is never the generic per-row `deny`.
 * `2`/`3` ("session"/"version") describe concepts this review does not have;
 * U5's only axis is what is pre-authorized now versus asked for later, so
 * they and any other digit resolve nothing.
 */
export function resolveInstallReviewDigit(
  digit: number,
  approval: PendingUnitInstallReviewApproval,
  selection: InstallSelection | undefined
): TemplateInstallResolution | null {
  if (digit === 1) return installAcceptanceFrom(approval, selection);
  if (digit === 4 && getInstallReviewActionCopy(approval).decline) return { decision: "cancel" };
  return null;
}

/** Whether the focused approval and key are this reducer's to handle — the gate a host checks before calling `applyInstallReviewNav`. Inert for every approval kind other than `unit-install-review`. */
export function shouldHandleInstallReviewNav(
  target: PendingApproval | undefined,
  nav: NavKey
): target is PendingUnitInstallReviewApproval {
  return target?.kind === "unit-install-review" && isInstallReviewNavKey(nav);
}

/** Where a digit keypress on the focused approval goes: the only valid resolution for a `unit-install-review` is `resolveInstallReview` (§8) — the generic once/session/version/deny path is used for every other kind. */
export type ApprovalDigitRoute =
  | { via: "resolveInstallReview"; approvalId: string; resolution: TemplateInstallResolution }
  | { via: "resolve"; approvalId: string; decision: ApprovalDecisionId }
  | { via: "none" };

export function routeApprovalDigit(
  target: PendingApproval | undefined,
  digit: number,
  selection: InstallSelection | undefined,
  genericDecisionByDigit: Record<number, ApprovalDecisionId>
): ApprovalDigitRoute {
  if (!target) return { via: "none" };
  if (target.kind === "unit-install-review") {
    const resolution = resolveInstallReviewDigit(digit, target, selection);
    return resolution
      ? { via: "resolveInstallReview", approvalId: target.approvalId, resolution }
      : { via: "none" };
  }
  const decision = genericDecisionByDigit[digit];
  return decision ? { via: "resolve", approvalId: target.approvalId, decision } : { via: "none" };
}

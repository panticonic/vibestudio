import { describe, expect, it } from "vitest";
import type { ApprovalDecisionId } from "@vibestudio/shared/approvalContract";
import type {
  InstallReviewOrigin,
  InstallReviewPart,
  InstallReviewPermissionRow,
} from "@vibestudio/shared/authority/unitInstallReview";
import type { PendingApproval } from "@vibestudio/shared/approvals";
import {
  applyInstallReviewNav,
  focusedRowKeyOf,
  INITIAL_INSTALL_REVIEW_NAV,
  isInstallReviewNavKey,
  resolveInstallReviewDigit,
  routeApprovalDigit,
  shouldHandleInstallReviewNav,
  type PendingUnitInstallReviewApproval,
} from "./installReviewNav.js";

const GENERIC_DECISION_BY_DIGIT: Record<number, ApprovalDecisionId> = {
  1: "once",
  2: "session",
  3: "version",
  4: "deny",
};

function capabilityApproval(): PendingApproval {
  return {
    kind: "capability",
    approvalId: "runtime-capability",
    callerId: "panel:chat",
    callerKind: "panel",
    repoPath: "panels/chat",
    effectiveVersion: "ev-runtime",
    requestedAt: 2,
    capability: "externalOpen",
    title: "Open external URL",
  };
}

function origin(overrides: Partial<InstallReviewOrigin> = {}): InstallReviewOrigin {
  return {
    url: "github.com/panticonic/news",
    originKey: "github.com/panticonic",
    registrableDomain: "panticonic.com",
    version: "1.2.0",
    isHostBuild: false,
    firstEncounter: false,
    ...overrides,
  };
}

function clearableRow(overrides: Partial<InstallReviewPermissionRow> = {}): InstallReviewPermissionRow {
  return {
    kind: "permission",
    key: overrides.key ?? "cap\0scope",
    timing: "on-add",
    notability: "headline",
    selectable: true,
    selectedByDefault: true,
    row: {
      capability: "externalOpen",
      domain: "safety",
      verb: "manage",
      action: "Fetches pages from any site",
      resource: "any site",
      resourceScope: { kind: "domain", domain: "safety" },
      tier: "gated",
      statement: "declared",
      provenance: { source: "manifest" },
      flags: {},
    },
    ...overrides,
  };
}

function part(index: number, overrides: Partial<InstallReviewPart> = {}): InstallReviewPart {
  return {
    identityKey: `part-${index}`,
    kind: "worker",
    label: "Agent",
    surfaces: [],
    name: `part-${index}`,
    title: `Part ${index}`,
    purpose: "Does something.",
    repoPath: `parts/part-${index}`,
    effectiveVersion: `ev-${index}`,
    version: null,
    requiredUnitKeys: [],
    runsInBackground: false,
    origin: origin(),
    notableRows: [clearableRow({ key: `row-${index}` })],
    everydayRows: [],
    change: "added",
    section: "template",
    ...overrides,
  };
}

function installReviewApproval(parts: InstallReviewPart[]): PendingUnitInstallReviewApproval {
  return {
    kind: "unit-install-review",
    approvalId: "install-1",
    callerId: "system",
    callerKind: "system",
    repoPath: "meta",
    effectiveVersion: "",
    requestedAt: 1,
    mode: "install",
    title: "Add News",
    description: "Adds parts.",
    template: {
      title: "News",
      purpose: "Read and discuss personalized news briefings.",
      origin: origin(),
      fromVersion: null,
      toVersion: "1.2.0",
    },
    parts,
    summary: { panels: 0, agents: parts.length, services: 0, clientApps: 0, extensions: 0 },
    unchangedPartCount: 0,
  } satisfies Extract<PendingApproval, { kind: "unit-install-review" }>;
}

describe("isInstallReviewNavKey", () => {
  it("recognizes left, right, tab, and space; nothing else", () => {
    expect(isInstallReviewNavKey("left")).toBe(true);
    expect(isInstallReviewNavKey("right")).toBe(true);
    expect(isInstallReviewNavKey("tab")).toBe(true);
    expect(isInstallReviewNavKey({ char: " " })).toBe(true);
    expect(isInstallReviewNavKey("up")).toBe(false);
    expect(isInstallReviewNavKey("down")).toBe(false);
    expect(isInstallReviewNavKey({ digit: 1 })).toBe(false);
    expect(isInstallReviewNavKey({ char: "n" })).toBe(false);
    expect(isInstallReviewNavKey(null)).toBe(false);
  });
});

describe("applyInstallReviewNav — part focus", () => {
  it("moves part focus with left/right and wraps at the ends", () => {
    const parts = [part(0), part(1), part(2)];
    let state = INITIAL_INSTALL_REVIEW_NAV;
    state = applyInstallReviewNav(state, "right", parts);
    expect(state.partIndex).toBe(1);
    state = applyInstallReviewNav(state, "right", parts);
    expect(state.partIndex).toBe(2);
    state = applyInstallReviewNav(state, "right", parts);
    expect(state.partIndex).toBe(0); // wraps
    state = applyInstallReviewNav(state, "left", parts);
    expect(state.partIndex).toBe(2); // wraps the other way
  });

  it("space toggles every clearable row of the focused part off, then back on", () => {
    const parts = [part(0), part(1)];
    let state = INITIAL_INSTALL_REVIEW_NAV;
    state = applyInstallReviewNav(state, { char: " " }, parts);
    expect([...(state.selection?.get("part-0") ?? [])]).toEqual([]);
    // The other part is untouched — still the platform default (selectedByDefault).
    expect(state.selection?.get("part-1")?.has("row-1")).toBe(true);
    state = applyInstallReviewNav(state, { char: " " }, parts);
    expect(state.selection?.get("part-0")?.has("row-0")).toBe(true);
  });

  it("is a no-op for nav keys it doesn't own", () => {
    const parts = [part(0)];
    const state = INITIAL_INSTALL_REVIEW_NAV;
    expect(applyInstallReviewNav(state, "up", parts)).toBe(state);
    expect(applyInstallReviewNav(state, "down", parts)).toBe(state);
    expect(applyInstallReviewNav(state, { digit: 1 }, parts)).toBe(state);
  });
});

describe("applyInstallReviewNav — permission-row focus", () => {
  it("tab expands the focused part, left/right then move between its rows, space toggles one", () => {
    const twoRowPart = part(0, {
      notableRows: [clearableRow({ key: "row-a" }), clearableRow({ key: "row-b" })],
    });
    const parts = [twoRowPart];
    let state = INITIAL_INSTALL_REVIEW_NAV;

    state = applyInstallReviewNav(state, "tab", parts);
    expect(state.rowExpanded).toBe(true);
    expect(focusedRowKeyOf(state, parts)).toBe("row-a");

    state = applyInstallReviewNav(state, "right", parts);
    expect(focusedRowKeyOf(state, parts)).toBe("row-b");

    state = applyInstallReviewNav(state, { char: " " }, parts);
    expect(state.selection?.get("part-0")?.has("row-b")).toBe(false);
    // Toggling one row leaves the part's other row selected — this was a
    // per-permission choice, not the whole-part toggle.
    expect(state.selection?.get("part-0")?.has("row-a")).toBe(true);

    state = applyInstallReviewNav(state, "tab", parts);
    expect(state.rowExpanded).toBe(false);
    expect(focusedRowKeyOf(state, parts)).toBeUndefined();
  });

  it("does not expand a part with nothing clearable", () => {
    const bareePart = part(0, { notableRows: [], everydayRows: [] });
    const state = applyInstallReviewNav(INITIAL_INSTALL_REVIEW_NAV, "tab", [bareePart]);
    expect(state.rowExpanded).toBe(false);
  });
});

describe("resolveInstallReviewDigit", () => {
  it("digit 1 accepts with the selection built so far", () => {
    const approval = installReviewApproval([part(0), part(1)]);
    let state = INITIAL_INSTALL_REVIEW_NAV;
    state = applyInstallReviewNav(state, { char: " " }, approval.parts); // deselect part-0

    const resolution = resolveInstallReviewDigit(1, approval, state.selection);

    expect(resolution).toEqual({
      decision: "install",
      allowNow: [
        { identityKey: "part-0", permissions: [] },
        { identityKey: "part-1", permissions: ["row-1"] },
      ],
    });
  });

  it("digit 1 with no selection touched falls back to the platform default", () => {
    const approval = installReviewApproval([part(0)]);
    const resolution = resolveInstallReviewDigit(1, approval, undefined);
    expect(resolution).toEqual({
      decision: "install",
      allowNow: [{ identityKey: "part-0", permissions: ["row-0"] }],
    });
  });

  it("digit 4 declines with a genuine cancel, never the generic deny", () => {
    const approval = installReviewApproval([part(0)]);
    const resolution = resolveInstallReviewDigit(4, approval, undefined);
    expect(resolution).toEqual({ decision: "cancel" });
  });

  it("digits 2 and 3 resolve nothing — this review has no 'session'/'version'", () => {
    const approval = installReviewApproval([part(0)]);
    expect(resolveInstallReviewDigit(2, approval, undefined)).toBeNull();
    expect(resolveInstallReviewDigit(3, approval, undefined)).toBeNull();
  });
});

describe("shouldHandleInstallReviewNav — the host's gate before applying a nav key", () => {
  it("is inert for every approval kind other than unit-install-review", () => {
    const capability = capabilityApproval();
    expect(shouldHandleInstallReviewNav(capability, "left")).toBe(false);
    expect(shouldHandleInstallReviewNav(capability, "right")).toBe(false);
    expect(shouldHandleInstallReviewNav(capability, "tab")).toBe(false);
    expect(shouldHandleInstallReviewNav(capability, { char: " " })).toBe(false);
    expect(shouldHandleInstallReviewNav(undefined, "left")).toBe(false);
  });

  it("is active for a unit-install-review, only on the keys it owns", () => {
    const approval = installReviewApproval([part(0)]);
    expect(shouldHandleInstallReviewNav(approval, "left")).toBe(true);
    expect(shouldHandleInstallReviewNav(approval, "right")).toBe(true);
    expect(shouldHandleInstallReviewNav(approval, "tab")).toBe(true);
    expect(shouldHandleInstallReviewNav(approval, { char: " " })).toBe(true);
    // ↑/↓ stay the approval list's — this reducer never claims them.
    expect(shouldHandleInstallReviewNav(approval, "up")).toBe(false);
    expect(shouldHandleInstallReviewNav(approval, "down")).toBe(false);
  });
});

describe("routeApprovalDigit — where a keypress-decision goes", () => {
  it("routes a unit-install-review through resolveInstallReview with the selection built so far, never the generic path", () => {
    const approval = installReviewApproval([part(0), part(1)]);
    const state = applyInstallReviewNav(INITIAL_INSTALL_REVIEW_NAV, { char: " " }, approval.parts); // deselect part-0

    const route = routeApprovalDigit(approval, 1, state.selection, GENERIC_DECISION_BY_DIGIT);

    expect(route).toEqual({
      via: "resolveInstallReview",
      approvalId: "install-1",
      resolution: {
        decision: "install",
        allowNow: [
          { identityKey: "part-0", permissions: [] },
          { identityKey: "part-1", permissions: ["row-1"] },
        ],
      },
    });
  });

  it("routes decline to a genuine cancel", () => {
    const approval = installReviewApproval([part(0)]);
    const route = routeApprovalDigit(approval, 4, undefined, GENERIC_DECISION_BY_DIGIT);
    expect(route).toEqual({
      via: "resolveInstallReview",
      approvalId: "install-1",
      resolution: { decision: "cancel" },
    });
  });

  it("is inert for a unit-install-review digit this review has no meaning for", () => {
    const approval = installReviewApproval([part(0)]);
    expect(routeApprovalDigit(approval, 2, undefined, GENERIC_DECISION_BY_DIGIT)).toEqual({
      via: "none",
    });
  });

  it("falls back to the generic once/session/version/deny path for every other approval kind", () => {
    const capability = capabilityApproval();
    const route = routeApprovalDigit(capability, 1, undefined, GENERIC_DECISION_BY_DIGIT);
    expect(route).toEqual({ via: "resolve", approvalId: "runtime-capability", decision: "once" });
  });

  it("resolves nothing when there is no focused approval", () => {
    expect(routeApprovalDigit(undefined, 1, undefined, GENERIC_DECISION_BY_DIGIT)).toEqual({
      via: "none",
    });
  });
});

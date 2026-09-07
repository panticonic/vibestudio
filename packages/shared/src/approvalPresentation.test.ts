import { describe, expect, it } from "vitest";
import {
  approvalPresentationKey as key,
  createApprovalPresentationState,
  reconcileApprovalPresentation as reconcile,
  selectApprovalPresentation as select,
  stepApprovalPresentation as step,
} from "./approvalPresentation";

const personal = {
  owner: { kind: "workspace" as const, workspaceId: "personal" },
  approvalId: "same-id",
  actionable: true,
};
const system = {
  owner: { kind: "workspace" as const, workspaceId: "system" },
  approvalId: "same-id",
  actionable: true,
};

describe("shared approval presentation", () => {
  it("distinguishes a server request from a workspace named hub", () => {
    const hub = { owner: { kind: "hub" as const }, approvalId: "same-id", actionable: true };
    const workspace = { ...hub, owner: { kind: "workspace" as const, workspaceId: "hub" } };
    const state = reconcile(createApprovalPresentationState(), [hub, workspace]);
    expect(key(hub)).not.toBe(key(workspace));
    expect(state.actionableKeys.size).toBe(2);
    expect(step(state, [hub, workspace], 1).selectedKey).toBe(key(workspace));
    expect(reconcile(state, [workspace]).selectedKey).toBe(key(workspace));
  });
  it("keeps colliding IDs separate and retains the answer being composed when another workspace asks", () => {
    const first = reconcile(createApprovalPresentationState(), [personal]);
    const next = reconcile(first, [personal, system]);
    expect(next.selectedKey).toBe(key(personal));
    expect(next.open).toBe(true);
    expect(step(next, [personal, system], 1).selectedKey).toBe(key(system));
  });

  it("opens for preparing becoming actionable, but respects dismissal of the same request", () => {
    const preparing = reconcile(createApprovalPresentationState(), [
      { ...system, actionable: false },
    ]);
    expect(preparing.open).toBe(false);
    const ready = reconcile(preparing, [system]);
    expect(ready.open).toBe(true);
    const dismissed = { ...ready, open: false };
    expect(reconcile(dismissed, [system])).toBe(dismissed);
    expect(reconcile(dismissed, [system, personal]).open).toBe(true);
  });

  it("moves on after completion without changing the identity of another owner's request", () => {
    const state = select(
      reconcile(createApprovalPresentationState(), [personal, system]),
      [personal, system],
      key(system)
    );
    expect(reconcile(state, [personal]).selectedKey).toBe(key(personal));
    expect(reconcile(state, []).open).toBe(false);
    expect(select(state, [personal, system], "missing")).toBe(state);
  });

  it("shows a new actionable request instead of an unrelated preparation", () => {
    const preparing = { ...personal, actionable: false };
    const state = reconcile(createApprovalPresentationState(), [preparing]);
    const next = reconcile(state, [preparing, system]);
    expect(next.selectedKey).toBe(key(system));
    expect(next.open).toBe(true);
  });
});

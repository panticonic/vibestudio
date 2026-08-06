import { describe, expect, it } from "vitest";
import type { PendingApproval, PendingUnitInstallReviewApproval } from "./approvals.js";
import type { InstallReviewPart } from "./authority/unitInstallReview.js";

import {
  filterBootstrapApprovals,
  filterBootstrapApprovalsForTarget,
  filterRuntimeApprovals,
} from "./bootstrapApprovals.js";

function part(overrides: Partial<InstallReviewPart> = {}): InstallReviewPart {
  return {
    identityKey: `${overrides.repoPath ?? "apps/shell"}@ev-test`,
    kind: "app",
    label: "Client App",
    surfaces: [],
    name: "@workspace-apps/shell",
    title: "Shell",
    purpose: "The desktop app itself.",
    repoPath: "apps/shell",
    effectiveVersion: "ev-test",
    version: "1.0.0",
    requiredUnitKeys: [],
    runsInBackground: false,
    target: "electron",
    origin: {
      url: null,
      originKey: "vibestudio",
      registrableDomain: null,
      version: "1.4.0",
      isHostBuild: true,
      firstEncounter: false,
    },
    notableRows: [],
    everydayRows: [],
    change: "added",
    section: "template",
    ...overrides,
  };
}

function review(
  parts: InstallReviewPart[],
  approvalId = "review-1"
): PendingUnitInstallReviewApproval {
  return {
    kind: "unit-install-review",
    approvalId,
    callerId: "system:startup",
    callerKind: "system",
    repoPath: "meta",
    effectiveVersion: "",
    requestedAt: Date.now(),
    mode: "adopt-root",
    title: "Start this workspace?",
    description: "Vibestudio needs to run programs on this computer.",
    parts,
    summary: { panels: 0, agents: 0, services: 0, clientApps: 0, extensions: 0 },
    unchangedPartCount: 0,
  };
}

const extensionPart = part({
  kind: "extension",
  label: "Extension",
  name: "@workspace-extensions/test",
  title: "Test Extension",
  repoPath: "extensions/test",
  target: null,
});

const credentialApproval: PendingApproval = {
  kind: "credential",
  allowedDecisions: ["once", "session", "version", "deny"],
  approvalId: "credential-1",
  callerId: "worker:chat",
  callerKind: "worker",
  repoPath: "workers/agent-worker",
  effectiveVersion: "ev:worker",
  requestedAt: Date.now(),
  credentialId: "cred-openai",
  credentialLabel: "OpenAI",
  audience: [],
  injection: { kind: "header", header: "Authorization" },
} as unknown as PendingApproval;

describe("which surface owns which review", () => {
  it("gives the launch gate the reviews it is the only surface that can render", () => {
    const gate = review([part(), extensionPart]);
    expect(filterBootstrapApprovals([credentialApproval, gate])).toEqual([gate]);
  });

  it("leaves a review of panels and workers to the running workspace", () => {
    // apps/shell can render this one, because it is not the code under review.
    const panels = review([part({ kind: "panel", label: "Panel", repoPath: "panels/chat" })]);
    expect(filterBootstrapApprovals([panels])).toEqual([]);
    expect(filterRuntimeApprovals([panels])).toEqual([panels]);
  });

  it("keeps a client-app review out of the app that would have to host it", () => {
    const gate = review([part()]);
    expect(filterRuntimeApprovals([credentialApproval, gate])).toEqual([credentialApproval]);
  });

  it("asks each host target only about its own app and the extensions it needs", () => {
    const desktop = review([part()], "desktop");
    const mobile = review([part({ target: "react-native", repoPath: "apps/mobile" })], "mobile");
    const extension = review([extensionPart], "extension");

    expect(
      filterBootstrapApprovalsForTarget([desktop, mobile, extension], "electron", [
        "extensions/test",
      ])
    ).toEqual([desktop, extension]);
    expect(filterBootstrapApprovalsForTarget([desktop, mobile, extension], "react-native")).toEqual(
      [mobile]
    );
  });

  it("does not ask a target about an extension it does not require", () => {
    const extension = review([extensionPart], "extension");
    expect(filterBootstrapApprovalsForTarget([extension], "electron", [])).toEqual([]);
  });
});

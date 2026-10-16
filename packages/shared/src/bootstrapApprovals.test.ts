import { describe, expect, it } from "vitest";
import type { PendingApproval, PendingUnitInstallReviewApproval } from "./approvals.js";
import type { InstallReviewPart } from "./authority/unitInstallReview.js";

import {
  filterBootstrapApprovals,
  filterBootstrapApprovalsForRuntime,
} from "./bootstrapApprovals.js";

function part(overrides: Partial<InstallReviewPart> = {}): InstallReviewPart {
  return {
    identityKey: `${overrides.repoPath ?? "clients/desktop-browser"}@ev-test`,
    kind: "client",
    label: "Client",
    surfaces: [],
    name: "@workspace-clients/desktop-browser",
    title: "Shell",
    purpose: "The desktop app itself.",
    repoPath: "clients/desktop-browser",
    effectiveVersion: "ev-test",
    version: "1.0.0",
    requiredUnitKeys: [],
    runsInBackground: false,
    runtime: "web",
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
    summary: { panels: 0, agents: 0, services: 0, clients: 0, extensions: 0 },
    unchangedPartCount: 0,
  };
}

const extensionPart = part({
  kind: "extension",
  label: "Extension",
  name: "@workspace-extensions/test",
  title: "Test Extension",
  repoPath: "extensions/test",
  runtime: null,
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
    const gate = review([
      part(),
      extensionPart,
      part({ kind: "panel", label: "Panel", repoPath: "panels/chat" }),
    ]);
    expect(filterBootstrapApprovals([credentialApproval, gate])).toEqual([gate]);
  });

  it("leaves a review of panels and workers to the running workspace", () => {
    // clients/desktop-browser can render this one, because it is not the code under review.
    const panels = review([part({ kind: "panel", label: "Panel", repoPath: "panels/chat" })]);
    expect(filterBootstrapApprovals([panels])).toEqual([]);
  });

  it("asks each runtime only about its own clients and the extensions it needs", () => {
    const desktop = review([part()], "desktop");
    const mobile = review(
      [part({ runtime: "react-native", repoPath: "clients/mobile-browser" })],
      "mobile"
    );
    const extension = review([extensionPart], "extension");

    expect(
      filterBootstrapApprovalsForRuntime([desktop, mobile, extension], "web", ["extensions/test"])
    ).toEqual([desktop, extension]);
    expect(
      filterBootstrapApprovalsForRuntime([desktop, mobile, extension], "react-native")
    ).toEqual([mobile]);
  });

  it("does not ask a runtime about an extension it does not require", () => {
    const extension = review([extensionPart], "extension");
    expect(filterBootstrapApprovalsForRuntime([extension], "web", [])).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import type { PendingApproval, PendingUnitBatchApproval } from "@vibestudio/shared/approvals";

import {
  filterBootstrapApprovals,
  filterBootstrapApprovalsForTarget,
  filterRuntimeApprovals,
} from "./bootstrapApprovals.js";

function unitBatch(
  trigger: PendingUnitBatchApproval["trigger"],
  opts: {
    kind?: "app" | "extension";
    target?: "electron" | "react-native" | "terminal" | null;
    extraUnits?: PendingUnitBatchApproval["units"];
  } = {}
): PendingUnitBatchApproval {
  const kind = opts.kind ?? "app";
  return {
    kind: "unit-batch",
    approvalId: `unit-${kind}-${trigger}-${opts.target ?? "none"}`,
    callerId: "system:startup",
    callerKind: "system",
    repoPath: "meta",
    executionDigest: "sourceDigest:startup",
    requestedAt: Date.now(),
    decisionDeadlineAt: Date.now() + 60_000,
    title: "Workspace units need approval",
    description: "Approve units.",
    trigger,
    units: [
      {
        unitKind: kind,
        unitName: kind === "app" ? "@workspace-apps/shell" : "@workspace-extensions/test",
        displayName: kind === "app" ? "Shell" : "Test Extension",
        target: kind === "app" ? (opts.target ?? "electron") : null,
        source: {
          kind: "workspace-repo",
          repo: kind === "app" ? "apps/shell" : "extensions/test",
          ref: "HEAD",
        },
        sourceDigest: "sourceDigest:test",
        capabilities: kind === "app" ? ["panel-hosting"] : ["native-code"],
      },
      ...(opts.extraUnits ?? []),
    ],
  };
}

describe("bootstrap approvals", () => {
  it("includes startup privileged unit approvals and legacy app meta approvals", () => {
    const credentialApproval: PendingApproval = {
      kind: "credential",
      approvalId: "credential-1",
      callerId: "worker:chat",
      callerKind: "worker",
      repoPath: "workers/agent-worker",
      executionDigest: "sourceDigest:worker",
      requestedAt: Date.now(),
      decisionDeadlineAt: Date.now() + 60_000,
      credentialId: "cred-openai",
      credentialLabel: "ChatGPT Codex model credential",
      audience: [],
      injection: { type: "header", name: "Authorization", valueTemplate: "Bearer {{token}}" },
      accountIdentity: { providerUserId: "acct" },
      scopes: [],
    };

    expect(
      filterBootstrapApprovals([
        credentialApproval,
        unitBatch("startup", { target: "electron" }),
        unitBatch("meta-change", { target: "react-native" }),
        unitBatch("startup", { kind: "extension" }),
        unitBatch("startup", {
          target: "terminal",
          extraUnits: [
            {
              unitKind: "extension",
              unitName: "@workspace-extensions/test",
              displayName: "Test Extension",
              target: null,
              source: { kind: "workspace-repo", repo: "extensions/test", ref: "HEAD" },
              sourceDigest: "sourceDigest:test",
              capabilities: ["native-code"],
            },
          ],
        }),
        unitBatch("source-change"),
        unitBatch("management"),
      ]).map((approval) => approval.approvalId)
    ).toEqual([
      "unit-app-startup-electron",
      "unit-app-meta-change-react-native",
      "unit-extension-startup-none",
      "unit-app-startup-terminal",
    ]);
  });

  it("matches startup units only to their app target or required provider extension", () => {
    const extensionStartup = unitBatch("startup", { kind: "extension" });
    const mixedStartup = unitBatch("startup", {
      target: "electron",
      extraUnits: [
        {
          unitKind: "extension",
          unitName: "@workspace-extensions/test",
          displayName: "Test Extension",
          target: null,
          source: { kind: "workspace-repo", repo: "extensions/test", ref: "HEAD" },
          sourceDigest: "sourceDigest:test",
          capabilities: ["native-code"],
        },
      ],
    });

    expect(
      filterBootstrapApprovalsForTarget(
        [extensionStartup, mixedStartup, unitBatch("source-change", { target: "electron" })],
        "react-native",
        ["extensions/test"]
      ).map((approval) => approval.approvalId)
    ).toEqual([extensionStartup.approvalId, mixedStartup.approvalId]);

    expect(
      filterBootstrapApprovalsForTarget([extensionStartup, mixedStartup], "terminal").map(
        (approval) => approval.approvalId
      )
    ).toEqual([]);
  });

  it("can still narrow app meta approvals to one host target", () => {
    expect(
      filterBootstrapApprovalsForTarget(
        [
          unitBatch("meta-change", { target: "electron" }),
          unitBatch("meta-change", {
            target: "react-native",
            extraUnits: [
              {
                unitKind: "app",
                unitName: "@workspace-apps/remote-cli",
                displayName: "Remote CLI",
                target: "terminal",
                source: { kind: "workspace-repo", repo: "apps/remote-cli", ref: "HEAD" },
                sourceDigest: "sourceDigest:terminal",
                capabilities: [],
              },
            ],
          }),
          unitBatch("meta-change", { target: "react-native" }),
          unitBatch("meta-change", { target: "terminal" }),
        ],
        "react-native"
      ).map((approval) => approval.approvalId)
    ).toEqual(["unit-app-meta-change-react-native"]);
  });

  it("removes startup privileged-unit approvals from the runtime consent queue", () => {
    const runtimeApproval = unitBatch("source-change", { target: "electron" });
    const appMetaApproval = unitBatch("meta-change", { target: "terminal" });
    const extensionStartupApproval = unitBatch("startup", { kind: "extension" });

    expect(
      filterRuntimeApprovals([
        unitBatch("startup", { target: "electron" }),
        appMetaApproval,
        extensionStartupApproval,
        runtimeApproval,
      ]).map((approval) => approval.approvalId)
    ).toEqual([
      appMetaApproval.approvalId,
      extensionStartupApproval.approvalId,
      runtimeApproval.approvalId,
    ]);
  });
});

import { describe, expect, it } from "vitest";
import type { PendingUnitBatchApproval } from "./approvals.js";
import {
  formatLaunchGateForTerminal,
  launchCopy,
  pendingSignature,
  plural,
  targetLabel,
  unitReviewRows,
  unitSummaryChips,
} from "./bootstrapLaunchGate.js";

const approval: PendingUnitBatchApproval = {
  approvalId: "approval-1",
  kind: "unit-batch",
  callerId: "system:apps",
  callerKind: "system",
  repoPath: "apps/mobile",
  executionDigest: "effective-version-1234567890",
  trigger: "startup",
  title: "Approve workspace apps",
  description: "Approve apps before launch",
  units: [
    {
      unitKind: "app",
      unitName: "@workspace-apps/mobile",
      displayName: "Mobile",
      target: "react-native",
      source: { kind: "workspace-repo", repo: "apps/mobile", ref: "main" },
      sourceDigest: "mobile-sourceDigest-1234567890",
      capabilities: ["notifications"],
      dependencySourceDigests: {},
      externalDeps: {},
    },
    {
      unitKind: "extension",
      unitName: "@workspace-extensions/react-native",
      displayName: "React Native Provider",
      source: { kind: "workspace-repo", repo: "extensions/react-native", ref: "main" },
      sourceDigest: "provider-sourceDigest-1234567890",
      capabilities: [],
      dependencySourceDigests: {},
      externalDeps: {},
    },
  ],
  configWrite: null,
  requestedAt: 1,
  decisionDeadlineAt: 60_001,
};

describe("bootstrapLaunchGate", () => {
  it("formats common labels and launch copy", () => {
    expect(targetLabel("electron")).toBe("Desktop");
    expect(targetLabel("react-native")).toBe("Mobile");
    expect(targetLabel("terminal")).toBe("Terminal");
    expect(plural(1, "app")).toBe("1 app");
    expect(plural(2, "app")).toBe("2 apps");
    expect(launchCopy(approval)).toEqual({
      title: "Apps and extensions requesting trust",
      summary: "Approving lets Vibestudio run the listed apps and extensions locally.",
    });
  });

  it("builds summary chips and detail rows for every host surface", () => {
    expect(unitSummaryChips(approval)).toEqual(["1 app", "1 extension", "1 mobile app"]);
    expect(unitReviewRows(approval)).toEqual([
      {
        name: "Mobile",
        source: "apps/mobile@main - mobile-sourc",
        capabilities: "notifications",
        kind: "Mobile",
      },
      {
        name: "React Native Provider",
        source: "extensions/react-native@main - provider-sou",
        capabilities: "No declared capabilities",
        kind: "Extension",
      },
    ]);
  });

  it("creates stable signatures and terminal review text", () => {
    expect(pendingSignature([approval])).toContain("approval-1|startup|app");
    expect(formatLaunchGateForTerminal([approval], "terminal")).toContain(
      "Terminal startup needs approval."
    );
    expect(formatLaunchGateForTerminal([approval], "terminal")).toContain(
      "Capabilities: notifications"
    );
  });
});

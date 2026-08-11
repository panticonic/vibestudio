// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { Theme } from "@radix-ui/themes";
import { describe, expect, it, vi } from "vitest";
import type { PendingUnitInstallReviewApproval } from "@vibestudio/shared/approvals";
import type {
  InstallReviewOrigin,
  InstallReviewPart,
} from "@vibestudio/shared/authority/unitInstallReview";
import { launchGateView } from "@vibestudio/shared/bootstrapLaunchGate";
import { formatLaunchGateForTerminal } from "@vibestudio/shared/bootstrapLaunchGate";

// The section talks to the workspace to list host targets; this test is about
// the launch gate it renders, so the client is a stub.
vi.mock("../shell/client", () => ({
  buildUnits: { list: vi.fn(() => Promise.resolve([])) },
  supervisedUnits: { list: vi.fn(() => Promise.resolve([])), versions: vi.fn() },
  workspace: { getConfig: vi.fn(() => Promise.resolve({})) },
  hostLaunch: { launch: vi.fn(), resolveApprovals: vi.fn() },
}));

const { LaunchGateFacts } = await import("./HostTargetsSection");

const hostOrigin: InstallReviewOrigin = {
  url: null,
  originKey: "vibestudio",
  registrableDomain: null,
  version: "1.4.0",
  isHostBuild: true,
  isWorkspaceRoot: true,
  firstEncounter: false,
};

const acme: InstallReviewOrigin = {
  url: "https://github.com/acme/studio",
  originKey: "github.com/acme",
  registrableDomain: "github.com",
  version: "v2.1",
  selfName: "Acme Studio",
  isHostBuild: false,
  isWorkspaceRoot: true,
  firstEncounter: true,
};

const lookalike: InstallReviewOrigin = {
  url: "https://github.com.attacker.net/acme/studio",
  originKey: "github.com.attacker.net/acme",
  registrableDomain: "attacker.net",
  version: "v1",
  isHostBuild: false,
  isWorkspaceRoot: true,
  firstEncounter: true,
};

function part(overrides: Partial<InstallReviewPart> = {}): InstallReviewPart {
  return {
    identityKey: `${overrides.repoPath ?? "apps/shell"}@ev`,
    kind: "app",
    label: "Client App",
    surfaces: [],
    name: "@workspace-apps/shell",
    title: "Shell",
    purpose: "The desktop app itself.",
    repoPath: "apps/shell",
    effectiveVersion: "ev",
    version: "1.0.0",
    requiredUnitKeys: [],
    runsInBackground: false,
    target: "electron",
    origin: hostOrigin,
    notableRows: [],
    everydayRows: [],
    change: "added",
    section: "template",
    ...overrides,
  };
}

function review(parts: InstallReviewPart[]): PendingUnitInstallReviewApproval {
  return {
    kind: "unit-install-review",
    approvalId: "gate-1",
    callerId: "system:startup",
    callerKind: "system",
    repoPath: "meta",
    effectiveVersion: "",
    requestedAt: 1,
    mode: "adopt-root",
    title: "Start this workspace?",
    description: "",
    parts,
    summary: { panels: 0, agents: 0, services: 0, clientApps: 0, extensions: 0 },
    unchangedPartCount: 0,
  };
}

function foreignRoot(origin: InstallReviewOrigin): PendingUnitInstallReviewApproval[] {
  return [
    review([
      part({ repoPath: "apps/studio", title: "Studio", origin }),
      part({
        kind: "extension",
        label: "Extension",
        repoPath: "extensions/acme-tools",
        title: "Acme Tools",
        target: null,
        origin,
      }),
    ]),
  ];
}

function draw(approvals: PendingUnitInstallReviewApproval[]) {
  return render(
    <Theme>
      <LaunchGateFacts approvals={approvals} />
    </Theme>
  );
}

describe("the launch gate on the shell surface", () => {
  it("renders the facts the window promotes to the top level", () => {
    const approvals = foreignRoot(acme);
    const view = launchGateView({ approvals });
    draw(approvals);

    // The first-encounter fact lives at the top level for a foreign root; this
    // surface used to read only the per-source line, which is null there — so
    // it dropped the single most useful signal it had.
    expect(screen.getByText(view.firstEncounterLine!)).toBeTruthy();
    expect(screen.getByText(view.programsLine!)).toBeTruthy();
    expect(screen.getByText(view.nativeCodeWarning!)).toBeTruthy();
    expect(screen.getByText(view.domainLine!)).toBeTruthy();
    expect(screen.getByText(view.declineConsequence)).toBeTruthy();
  });

  it("renders those facts in the window's order, before the sources", () => {
    const approvals = foreignRoot(acme);
    const view = launchGateView({ approvals });
    const { container } = draw(approvals);
    const text = container.textContent ?? "";

    const order = [
      view.summary,
      view.domainLine!,
      view.firstEncounterLine!,
      view.programsLine!,
      view.nativeCodeWarning!,
    ].map((line) => text.indexOf(line));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((left, right) => left - right)).toEqual(order);
    // And all of it before the unit rows it is about.
    expect(order[order.length - 1]!).toBeLessThan(text.indexOf("Acme Tools"));
  });

  it("emphasizes the registrable domain inside the URL, never a lookalike prefix", () => {
    const { container } = draw(foreignRoot(lookalike));
    const emphasized = [...container.querySelectorAll("strong")].map((node) => node.textContent);

    expect(emphasized).toContain("attacker.net");
    expect(emphasized).not.toContain("github.com");
    // The URL is never abbreviated away by the emphasis.
    expect(container.textContent).toContain("https://github.com.attacker.net/acme/studio");
  });

  it("says the domain in words as well as in weight", () => {
    const { container } = draw(foreignRoot(lookalike));
    // Emphasis is invisible to a screen reader and to a monochrome display, so
    // the same fact the terminal prints is on screen too.
    expect(screen.getAllByText("Domain: attacker.net").length).toBeGreaterThan(0);
    expect(container.textContent).not.toContain("Domain: github.com");
  });

  it("carries the same facts as the terminal form of the same gate", () => {
    const approvals = foreignRoot(acme);
    const { container } = draw(approvals);
    const text = container.textContent ?? "";
    const terminal = formatLaunchGateForTerminal(approvals, "electron");

    for (const line of [
      launchGateView({ approvals }).summary,
      "Domain: github.com",
      "You haven't run code from github.com/acme before.",
      '"Acme Studio" — name given by this template',
      "Vibestudio won't start. Nothing is installed or changed.",
    ]) {
      expect(text).toContain(line);
      expect(terminal).toContain(line);
    }
  });

  it("renders no commit id or content digest at any level", () => {
    const { container } = draw(foreignRoot(acme));
    expect(container.textContent).not.toMatch(/[0-9a-f]{40}/u);
  });
});

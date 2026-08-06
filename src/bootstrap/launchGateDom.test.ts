// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import type { PendingUnitInstallReviewApproval } from "@vibestudio/shared/approvals";
import type {
  InstallReviewOrigin,
  InstallReviewPart,
} from "@vibestudio/shared/authority/unitInstallReview";
import {
  formatLaunchGateForTerminal,
  launchGateView,
} from "@vibestudio/shared/bootstrapLaunchGate";
import { appendLaunchGateFacts, appendSources } from "./launchGateDom.js";

/**
 * The launch gate window's identity presentation (§7.6.3, §13.6).
 *
 * This is the surface that decides whether foreign native code runs, and after
 * the creation review it is the only review these units ever get — so what it
 * writes on screen is tested rather than assumed.
 */

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
  selfName: "GitHub",
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

function card(approvals: PendingUnitInstallReviewApproval[]): {
  element: HTMLElement;
  described: string[];
} {
  const view = launchGateView({ approvals });
  const element = document.createElement("article");
  const described = appendLaunchGateFacts(element, view);
  appendSources(element, view, { open: false });
  return { element, described };
}

function emphasizedText(element: HTMLElement): string[] {
  return [...element.querySelectorAll("strong")].map((node) => node.textContent ?? "");
}

describe("the launch gate window's identity presentation", () => {
  it("emphasizes the registrable domain within the URL, never a lookalike prefix", () => {
    const { element } = card(foreignRoot(lookalike));

    expect(emphasizedText(element)).toContain("attacker.net");
    expect(emphasizedText(element)).not.toContain("github.com");
    // Emphasis marks the URL; it never replaces or shortens it.
    expect(element.textContent).toContain("https://github.com.attacker.net/acme/studio");
  });

  it("emphasizes with structure and weight, not colour alone", () => {
    const { element } = card(foreignRoot(acme));
    const marks = [...element.querySelectorAll("strong.origin-domain")];

    // `<strong>` survives a stylesheet that never loads and reaches a screen
    // reader's element list; the class only carries weight and an underline.
    expect(marks.length).toBeGreaterThan(0);
    expect(marks.every((mark) => mark.tagName === "STRONG")).toBe(true);
  });

  it("says the domain in words as well as in weight", () => {
    const { element, described } = card(foreignRoot(lookalike));

    const domain = element.querySelector("#launch-gate-domain");
    expect(domain?.textContent).toBe("Domain: attacker.net");
    // Announced with the group, so it is heard before the actions rather than
    // depending on a weight difference nobody hears.
    expect(described).toContain("launch-gate-domain");
    expect(element.textContent).not.toContain("Domain: github.com");
  });

  it("renders the promoted facts in order, before the sources and the actions", () => {
    const approvals = foreignRoot(acme);
    const view = launchGateView({ approvals });
    const { element, described } = card(approvals);
    const text = element.textContent ?? "";

    expect(described).toEqual([
      "launch-gate-summary",
      "launch-gate-domain",
      "launch-gate-first-encounter",
      "launch-gate-programs",
      "launch-gate-native-warning",
    ]);
    const order = [
      view.summary,
      view.domainLine!,
      view.firstEncounterLine!,
      view.programsLine!,
      view.nativeCodeWarning!,
    ].map((line) => text.indexOf(line));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((left, right) => left - right)).toEqual(order);
  });

  it("carries the same facts as the terminal form of the same gate", () => {
    const approvals = foreignRoot(acme);
    const { element } = card(approvals);
    const text = element.textContent ?? "";
    const terminal = formatLaunchGateForTerminal(approvals, "electron");
    const view = launchGateView({ approvals });

    for (const line of [
      view.summary,
      view.domainLine!,
      view.firstEncounterLine!,
      view.programsLine!,
      view.nativeCodeWarning!,
      // …down to the unit rows and the self-given name's attributed slot.
      "Acme Tools",
      '"Acme Studio" — name given by this template',
    ]) {
      expect(text).toContain(line);
      expect(terminal).toContain(line);
    }
  });

  it("keeps a template's self-given name out of every identity position", () => {
    const { element } = card(foreignRoot(lookalike));
    const identity = element.querySelector(".launch-origin");

    expect(identity?.textContent).toBe("https://github.com.attacker.net/acme/studio  at v1");
    // The name survives only where it says whose name it is.
    expect(element.textContent).toContain('"GitHub" — name given by this template');
    expect(emphasizedText(element)).not.toContain("GitHub");
  });

  it("names our own build without inventing a domain for it", () => {
    const { element } = card([review([part(), part({ repoPath: "apps/other" })])]);

    expect(element.textContent).toContain("Vibestudio 1.4.0");
    expect(element.textContent).not.toContain("Domain:");
    expect(emphasizedText(element)).toEqual([]);
  });

  it("renders no commit id or content digest at any disclosure level", () => {
    const { element } = card(foreignRoot(acme));
    expect(element.textContent).not.toMatch(/[0-9a-f]{40}/u);
  });
});

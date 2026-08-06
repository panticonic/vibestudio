import { describe, expect, it } from "vitest";
import React from "react";
import { render } from "ink";
import { Writable } from "node:stream";
import type { PendingApproval } from "@vibestudio/shared/approvals";
import type {
  InstallReviewOrigin,
  InstallReviewPart,
  InstallReviewPermissionRow,
} from "@vibestudio/shared/authority/unitInstallReview";
import {
  ApprovalsOverlay,
  installAcceptanceFrom,
  type InstallSelection,
} from "./ApprovalsOverlay.js";

/**
 * A minimal, non-TTY Ink render harness. There is no `ink-testing-library` in
 * this workspace, so this renders through Ink's real `debug` mode (the same
 * mode it uses for CI output) into an in-memory stream and returns the last
 * frame. A non-TTY stdout also makes chalk/ink skip ANSI styling entirely, so
 * the captured frame is already plain text.
 */
function renderToText(node: React.ReactElement): string {
  const frames: string[] = [];
  const stdout = new Writable({
    write(chunk, _enc, callback) {
      frames.push(chunk.toString());
      callback();
    },
  }) as unknown as NodeJS.WriteStream;
  Object.assign(stdout, { columns: 100, isTTY: false });
  const stdin = new Writable({
    write(_chunk, _enc, callback) {
      callback();
    },
  }) as unknown as NodeJS.ReadStream;
  Object.assign(stdin, {
    isTTY: false,
    setRawMode: () => stdin,
    setEncoding: () => stdin,
    read: () => null,
    ref: () => stdin,
    unref: () => stdin,
  });

  const { unmount } = render(node, { stdout, stdin, debug: true, patchConsole: false });
  unmount();
  return frames[frames.length - 2] ?? frames[frames.length - 1] ?? "";
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

function permissionRow(
  overrides: Partial<InstallReviewPermissionRow> = {}
): InstallReviewPermissionRow {
  return {
    kind: "permission",
    key: overrides.key ?? "cap\0scope",
    timing: "asks-when-needed",
    notability: "headline",
    selectable: false,
    selectedByDefault: false,
    row: {
      capability: "externalOpen",
      domain: "safety",
      verb: "manage",
      action: "Fetches pages from any site",
      resource: "any site",
      resourceScope: { kind: "network", value: "*" },
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
    notableRows: [],
    everydayRows: [],
    change: "added",
    section: "template",
    ...overrides,
  };
}

function installReviewApproval(parts: InstallReviewPart[]): PendingApproval {
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
    description: "Adds 37 parts.",
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
  };
}

describe("ApprovalsOverlay — unit-install-review", () => {
  it("renders every part, never a truncated '…and N more' summary", () => {
    const parts = Array.from({ length: 37 }, (_, i) => part(i));
    const text = renderToText(
      <ApprovalsOverlay pending={[installReviewApproval(parts)]} selectedIndex={0} />
    );

    for (const p of parts) {
      expect(text).toContain(p.title);
    }
    expect(text).not.toMatch(/and \d+ more/);
  });

  it("shows title, kind label, and the notable line for a part with nothing unusual", () => {
    const p = part(0, {
      title: "News",
      label: "Panel",
      everydayRows: [permissionRow(), permissionRow({ key: "b" })],
    });
    const text = renderToText(
      <ApprovalsOverlay pending={[installReviewApproval([p])]} selectedIndex={0} />
    );

    expect(text).toContain("News");
    expect(text).toContain("Panel");
    expect(text).toContain("Nothing unusual · 2 everyday permissions");
  });

  it("discloses everyday permission rows while permission navigation is open", () => {
    const everyday = permissionRow({
      key: "everyday-network",
      row: {
        capability: "network",
        domain: "safety",
        verb: "manage",
        action: "Checks the weather service",
        resource: "the weather service",
        resourceScope: { kind: "network", value: "*" },
        tier: "gated",
        statement: "declared",
        provenance: { source: "manifest" },
        flags: {},
      },
    });
    const reviewed = part(0, { notableRows: [], everydayRows: [everyday] });

    const collapsed = renderToText(
      <ApprovalsOverlay pending={[installReviewApproval([reviewed])]} selectedIndex={0} />
    );
    const expanded = renderToText(
      <ApprovalsOverlay
        pending={[installReviewApproval([reviewed])]}
        selectedIndex={0}
        focusedRowKey={everyday.key}
      />
    );

    expect(collapsed).not.toContain("Checks the weather service");
    expect(expanded).toContain("Checks the weather service");
  });

  it("shows the focused part's Worth knowing rows and their sign in a differential review", () => {
    const changed = part(0, {
      title: "News Agent",
      change: "changed",
      notableRows: [
        permissionRow({
          key: "added-row",
          change: "added",
          row: {
            capability: "externalOpen",
            domain: "safety",
            verb: "manage",
            action: "Fetches pages from any site",
            resource: "any site",
            resourceScope: { kind: "network", value: "*" },
            tier: "gated",
            statement: "declared",
            provenance: { source: "manifest" },
            flags: {},
          },
        }),
        permissionRow({
          key: "removed-row",
          change: "removed",
          row: {
            capability: "workspaceFiles",
            domain: "safety",
            verb: "manage",
            action: "Reads and writes files in this workspace",
            resource: "this workspace",
            resourceScope: { kind: "network", value: "*" },
            tier: "gated",
            statement: "declared",
            provenance: { source: "manifest" },
            flags: {},
          },
        }),
      ],
    });
    const text = renderToText(
      <ApprovalsOverlay
        pending={[installReviewApproval([changed])]}
        selectedIndex={0}
        partIndex={0}
      />
    );

    expect(text).toContain("+ Fetches pages from any site");
    expect(text).toContain("− Reads and writes files in this workspace");
  });

  it("marks a selectable row's checkbox from the controlled installSelection", () => {
    const clearableRow = permissionRow({
      key: "clearable",
      selectable: true,
      selectedByDefault: true,
      timing: "on-add",
      row: {
        capability: "externalOpen",
        domain: "safety",
        verb: "manage",
        action: "Fetches pages from any site",
        resource: "any site",
        resourceScope: { kind: "network", value: "*" },
        tier: "gated",
        statement: "declared",
        provenance: { source: "manifest" },
        flags: {},
      },
    });
    const p = part(0, { identityKey: "news-agent", notableRows: [clearableRow] });
    const deselected: InstallSelection = new Map([["news-agent", new Set<string>()]]);

    const checked = renderToText(
      <ApprovalsOverlay pending={[installReviewApproval([p])]} selectedIndex={0} partIndex={0} />
    );
    const unchecked = renderToText(
      <ApprovalsOverlay
        pending={[installReviewApproval([p])]}
        selectedIndex={0}
        partIndex={0}
        installSelection={deselected}
      />
    );

    expect(checked).toContain("☑ Fetches pages from any site");
    expect(unchecked).toContain("☐ Fetches pages from any site");
    // Deselecting the row also flips the part-level checkbox glyph (U5).
    const partLine = (text: string) => text.split("\n").find((line) => line.includes(p.title));
    expect(partLine(checked)).toContain("☑");
    expect(partLine(unchecked)).toContain("☐");
  });

  it("shows where the focused part's bytes came from, whole, with its domain named", () => {
    // A lookalike host is the case the URL alone cannot defend against: the
    // domain that owns `github.com.attacker.net` is `attacker.net`, and the
    // frame must say so without shortening the URL to it.
    const lookalike = origin({
      url: "https://github.com.attacker.net/acme/studio",
      originKey: "github.com.attacker.net/acme",
      registrableDomain: "attacker.net",
    });
    const text = renderToText(
      <ApprovalsOverlay
        pending={[installReviewApproval([part(0, { origin: lookalike })])]}
        selectedIndex={0}
        partIndex={0}
      />
    );

    expect(text).toContain("https://github.com.attacker.net/acme/studio");
    // Bold is unavailable on a non-TTY frame and unheard by a screen reader, so
    // the domain is also stated in the same words the launch gate's plain-text
    // form uses.
    expect(text).toContain("Domain: attacker.net");
    expect(text).not.toContain("Domain: github.com");
  });

  it("names no domain for the host's own build, which asserts nothing", () => {
    const text = renderToText(
      <ApprovalsOverlay
        pending={[
          installReviewApproval([
            part(0, {
              origin: origin({
                url: null,
                originKey: "vibestudio",
                registrableDomain: null,
                isHostBuild: true,
              }),
            }),
          ]),
        ]}
        selectedIndex={0}
        partIndex={0}
      />
    );

    expect(text).not.toContain("Domain:");
  });
});

describe("installAcceptanceFrom — per-part selection reaches the resolution payload", () => {
  it("defaults to the platform's full-slate acceptance when nothing is deselected", () => {
    const parts = [part(0, { identityKey: "a" }), part(1, { identityKey: "b" })];
    const approval = installReviewApproval(parts) as Extract<
      PendingApproval,
      { kind: "unit-install-review" }
    >;

    const acceptance = installAcceptanceFrom(approval, undefined);

    expect(acceptance.decision).toBe("install");
    expect(acceptance.allowNow.map((entry) => entry.identityKey).sort()).toEqual(["a", "b"]);
  });

  it("carries a deselected part's row keys as 'ask when needed' (empty permissions)", () => {
    const clearableRow = permissionRow({
      key: "clearable",
      selectable: true,
      selectedByDefault: true,
    });
    const parts = [
      part(0, { identityKey: "a", notableRows: [clearableRow] }),
      part(1, { identityKey: "b" }),
    ];
    const approval = installReviewApproval(parts) as Extract<
      PendingApproval,
      { kind: "unit-install-review" }
    >;
    // The user deselected part "a" entirely: allow now for "a" is empty.
    const selection: InstallSelection = new Map([
      ["a", new Set<string>()],
      ["b", new Set<string>()],
    ]);

    const acceptance = installAcceptanceFrom(approval, selection);

    expect(acceptance.allowNow).toEqual([
      { identityKey: "a", permissions: [] },
      { identityKey: "b", permissions: [] },
    ]);
  });

  it("omits a removed part from allowNow regardless of selection", () => {
    const parts = [part(0, { identityKey: "a", change: "removed" }), part(1, { identityKey: "b" })];
    const approval = installReviewApproval(parts) as Extract<
      PendingApproval,
      { kind: "unit-install-review" }
    >;
    const selection: InstallSelection = new Map([["a", new Set(["should-not-appear"])]]);

    const acceptance = installAcceptanceFrom(approval, selection);

    expect(acceptance.allowNow.map((entry) => entry.identityKey)).toEqual(["b"]);
  });
});

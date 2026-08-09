import { describe, expect, it } from "vitest";
import type { AuthorityRow } from "./authorityRows.js";
import type { UnitAuthorityRequest } from "../authorityManifest.js";
import {
  clearableRows,
  defaultAcceptance,
  differentialPartRank,
  groupInstallParts,
  installPartGroupCount,
  installPartLabel,
  installReviewRows,
  installRowKey,
  partNotableLine,
  selectionStatusLine,
  summarizeParts,
  type InstallReviewPart,
  type InstallReviewRow,
} from "./unitInstallReview.js";

function row(action: string, overrides: Partial<InstallReviewRow> = {}): InstallReviewRow {
  const authorityRow: AuthorityRow = {
    capability: `cap.${action.replace(/\s+/g, "-")}`,
    domain: "files",
    verb: "act",
    action,
    resource: "anything in this workspace",
    resourceScope: { kind: "prefix", prefix: "" },
    tier: "gated",
    statement: "declared",
    provenance: { source: "manifest" },
    flags: {},
  };
  return {
    kind: "permission",
    key: installRowKey(authorityRow),
    row: authorityRow,
    timing: "on-add",
    notability: "everyday",
    selectable: true,
    selectedByDefault: true,
    ...overrides,
  } as InstallReviewRow;
}

function part(overrides: Partial<InstallReviewPart> = {}): InstallReviewPart {
  return {
    identityKey: "unit:news",
    kind: "worker",
    label: "Agent",
    surfaces: [],
    name: "@news/agent",
    title: "News Agent",
    purpose: "Fetches and summarizes articles on a schedule.",
    repoPath: "workers/news-agent",
    effectiveVersion: "ev-1",
    version: "1.2.0",
    requiredUnitKeys: [],
    runsInBackground: true,
    origin: {
      url: "https://github.com/panticonic/news",
      originKey: "github.com/panticonic",
      registrableDomain: "github.com",
      version: "v1.2.0",
      isHostBuild: false,
      firstEncounter: true,
    },
    notableRows: [],
    everydayRows: [],
    change: "added",
    section: "template",
    ...overrides,
  };
}

describe("part kinds", () => {
  it("splits workers by a computable test rather than by judgment", () => {
    expect(installPartLabel("worker", [])).toBe("Agent");
    expect(installPartLabel("worker", [{ kind: "service", name: "model-settings" }])).toBe(
      "Service"
    );
    expect(installPartLabel("worker", [{ kind: "durable-object", name: "PubsubChannel" }])).toBe(
      "Service"
    );
    expect(installPartLabel("panel", [])).toBe("Panel");
    expect(installPartLabel("app", [])).toBe("Client App");
    expect(installPartLabel("extension", [])).toBe("Extension");
  });
});

describe("part groups", () => {
  it("uses one repository-derived order and vocabulary for every review surface", () => {
    const groups = groupInstallParts([
      part({ identityKey: "extension", repoPath: "extensions/git", title: "Git" }),
      part({
        identityKey: "service",
        repoPath: "workers/pubsub",
        label: "Service",
        title: "Pubsub",
      }),
      part({ identityKey: "about", repoPath: "about/accounts", title: "Accounts" }),
      part({ identityKey: "agent", repoPath: "workers/news", title: "News" }),
      part({ identityKey: "panel", repoPath: "panels/chat", title: "Chat" }),
    ]);

    expect(groups.map((group) => group.title)).toEqual([
      "App panels",
      "Agents and background tasks",
      "System panels",
      "Services",
      "Extensions",
    ]);
  });

  it("summarizes names, overflow, and notability while a group is folded", () => {
    const notable = row("send a notification", { notability: "headline" });
    const [group] = groupInstallParts([
      part({ identityKey: "chat", repoPath: "panels/chat", title: "Chat" }),
      part({
        identityKey: "terminal",
        repoPath: "panels/terminal",
        title: "Terminal",
        notableRows: [notable],
      }),
      part({ identityKey: "news", repoPath: "panels/news", title: "News" }),
    ]);

    expect(group && installPartGroupCount(group)).toBe(3);
  });
});

describe("the notable line", () => {
  it("states an ordinary footprint rather than claiming innocence", () => {
    expect(partNotableLine(part({ everydayRows: [row("a"), row("b"), row("c")] }))).toBe(
      "Nothing unusual · 3 everyday permissions"
    );
    expect(partNotableLine(part())).toBe("Nothing unusual");
  });

  it("shows at most two headline phrases", () => {
    const notable = [
      row("Works on its own"),
      row("Can send things outside this workspace"),
      row("Fetches pages from any site"),
    ];
    expect(partNotableLine(part({ notableRows: notable }))).toBe(
      "Works on its own · Can send things outside this workspace"
    );
  });
});

describe("selection", () => {
  it("checks every part and every install-clearable row by default", () => {
    const cleared = row("Reads and writes files in this workspace");
    const disclosure = row("Can use an account you've connected", {
      timing: "asks-when-needed",
      selectable: false,
      selectedByDefault: false,
    });
    const acceptance = defaultAcceptance("install", [
      part({ notableRows: [disclosure], everydayRows: [cleared] }),
    ]);

    expect(acceptance).toEqual({
      decision: "install",
      allowNow: [{ identityKey: "unit:news", permissions: [cleared.key] }],
    });
  });

  it("never offers a checkbox for a row this decision cannot grant", () => {
    const disclosure = row("Confirms before it publishes", {
      timing: "asks-every-time",
      selectable: false,
      selectedByDefault: false,
    });
    expect(clearableRows(part({ notableRows: [disclosure] }))).toEqual([]);
  });

  it("restates the selection in plain terms", () => {
    const a = row("a");
    const b = row("b");
    const parts = [
      part({ identityKey: "one", everydayRows: [a, b] }),
      part({ identityKey: "two", everydayRows: [a] }),
      part({ identityKey: "three", everydayRows: [a] }),
    ];

    expect(
      selectionStatusLine({ parts, allowNow: defaultAcceptance("install", parts).allowNow })
    ).toBe("3 parts · everything allowed now");

    expect(
      selectionStatusLine({
        parts,
        allowNow: [
          { identityKey: "one", permissions: [] },
          { identityKey: "two", permissions: [a.key] },
          { identityKey: "three", permissions: [a.key] },
        ],
      })
    ).toBe("3 parts · 1 will ask before anything");

    expect(
      selectionStatusLine({
        parts,
        allowNow: [
          { identityKey: "one", permissions: [a.key] },
          { identityKey: "two", permissions: [a.key] },
          { identityKey: "three", permissions: [a.key] },
        ],
      })
    ).toBe("3 parts · 1 will ask before it does 1 thing");
  });

  it("treats an absent entry as ask-when-needed, not as removed", () => {
    const a = row("a");
    const parts = [part({ identityKey: "one", everydayRows: [a] })];
    expect(selectionStatusLine({ parts, allowNow: [] })).toBe(
      "1 part · 1 will ask before anything"
    );
  });
});

describe("differential ordering", () => {
  it("puts new or widened permissions first and removed parts last", () => {
    const widened = part({ change: "changed", notableRows: [row("x", { change: "added" })] });
    const narrowed = part({ change: "changed", notableRows: [row("y", { change: "removed" })] });
    const added = part({ change: "added" });
    const removed = part({ change: "removed" });

    expect(
      [removed, added, narrowed, widened].sort(
        (l, r) => differentialPartRank(l) - differentialPartRank(r)
      )
    ).toEqual([widened, narrowed, added, removed]);
  });
});

describe("summary", () => {
  it("counts by the user-facing label and ignores removed parts", () => {
    expect(
      summarizeParts([
        part({ label: "Panel" }),
        part({ label: "Agent" }),
        part({ label: "Service" }),
        part({ label: "Extension", change: "removed" }),
      ])
    ).toEqual({ panels: 1, agents: 1, services: 1, clientApps: 0, extensions: 0 });
  });
});

describe("building rows from a declaration", () => {
  const request = (
    capability: string,
    tier: "gated" | "critical" = "gated",
    resource: UnitAuthorityRequest["resource"] = { kind: "prefix", prefix: "" }
  ): UnitAuthorityRequest => ({ capability, resource, tier, evidence: "intentional-broad" });

  it("clears ordinary reviewed requests at install and leaves accounts asking at use", () => {
    const { notableRows, everydayRows } = installReviewRows({
      requests: [request("workspace.files.write"), request("credential.use")],
    });

    expect(everydayRows.map((r) => [r.timing, r.selectable])).toEqual([["on-add", true]]);
    expect(notableRows.map((r) => [r.timing, r.selectable])).toEqual([["asks-when-needed", false]]);
  });

  it("clears shipped service-discovery envelopes in the initial review", () => {
    const { notableRows, everydayRows } = installReviewRows({
      requests: [
        request("workspace-service:channel"),
        request("workspace-service:development"),
        request("workspace-service:models"),
        request("workspace-service:missions"),
        request("workspace-service:testkit-driver"),
        request("workspace-service:browser.data"),
      ],
    });

    expect(notableRows).toEqual([]);
    expect(everydayRows).toHaveLength(6);
    expect(everydayRows.every((row) => row.timing === "on-add" && row.selectable)).toBe(true);
  });

  it("names the protocol a service row was reached through, and its current provider", () => {
    // The manifest declares protocols, so the reviewer cannot tell from it
    // alone which provider a unit talks to. The row has to carry that join.
    const { notableRows, everydayRows } = installReviewRows({
      requests: [request("workspace-service:local-notifications")],
      serviceBindings: [
        {
          protocol: "example.notifications.v1",
          availability: "required",
          serviceName: "local-notifications",
          providerUnit: "@workspace-workers/notifications",
          catalogDigest: "catalog-notifications",
        },
      ],
    });

    const rows = [...notableRows, ...everydayRows];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind === "permission" ? rows[0].binding : undefined).toEqual({
      protocol: "example.notifications.v1",
      availability: "required",
      serviceName: "local-notifications",
      providerUnit: "@workspace-workers/notifications",
      catalogDigest: "catalog-notifications",
    });
  });

  it("leaves a service row unbound when no declaration resolved to it", () => {
    const { notableRows, everydayRows } = installReviewRows({
      requests: [request("workspace-service:local-notifications")],
      serviceBindings: [
        {
          protocol: "example.other.v1",
          availability: "optional",
          serviceName: null,
          providerUnit: null,
          catalogDigest: null,
        },
      ],
    });

    const rows = [...notableRows, ...everydayRows];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind === "permission" ? rows[0].binding : "absent").toBe(undefined);
  });

  it("never offers a checkbox for a critical request", () => {
    const { notableRows } = installReviewRows({ requests: [request("git.publish", "critical")] });
    expect(notableRows).toHaveLength(1);
    expect(notableRows[0]).toMatchObject({
      timing: "asks-every-time",
      notability: "headline",
      selectable: false,
    });
  });

  it("keeps a unit's own declared origin ordinary while any-site egress asks at use", () => {
    const declared = installReviewRows({
      requests: [
        request("network.fetch", "gated", { kind: "origin", origin: "https://news.example" }),
      ],
    });
    const anySite = installReviewRows({
      requests: [request("network.fetch", "gated", { kind: "network", value: "*" })],
    });

    expect(declared.notableRows[0]?.timing).toBe("on-add");
    expect(anySite.notableRows[0]?.timing).toBe("asks-when-needed");
  });

  it("renders an unrecognized capability rather than failing inspection", () => {
    const { notableRows } = installReviewRows({
      requests: [request("nonsense.capability.a-template-invented")],
    });

    expect(notableRows).toHaveLength(1);
    expect(notableRows[0]).toMatchObject({ notability: "headline", timing: "asks-when-needed" });
  });

  it("classifies a receiver capability only when the operation carries its definition", () => {
    const definition = {
      name: "external-tool.execute",
      title: "Run an external tool",
      action: "run an external tool",
      tier: "gated",
      sensitivity: "write",
      resourceType: "tool",
      presentation: { domain: "automation", verb: "act" },
      notability: "headline",
      grantScopes: ["once", "task", "version"],
    } as const;
    const requests = [request("workspace-service:external-tool.execute")];

    expect(installReviewRows({ requests }).notableRows[0]?.timing).toBe("asks-when-needed");
    expect(
      installReviewRows({
        requests,
        userlandDefinitions: new Map([["workspace-service:external-tool.execute", definition]]),
      }).notableRows[0]?.timing
    ).toBe("on-add");
  });

  it("reduces an admin receiver capability to asking at use whatever its provider declared", () => {
    const definition = {
      name: "channel.admin",
      title: "Administer a channel",
      action: "administer a channel",
      tier: "gated",
      sensitivity: "admin",
      resourceType: "channel",
      presentation: { domain: "sharing", verb: "manage" },
      notability: "headline",
      grantScopes: ["once", "task", "version"],
    } as const;

    expect(
      installReviewRows({
        requests: [request("workspace-service:channel.admin")],
        userlandDefinitions: new Map([["workspace-service:channel.admin", definition]]),
      }).notableRows[0]?.timing
    ).toBe("asks-when-needed");
  });

  it("uses a workspace service declaration for review and notability", () => {
    const { notableRows, everydayRows } = installReviewRows({
      requests: [request("workspace-service:notes")],
      presentationFor: (capability) => ({
        group: "runtime",
        title: "Team notes",
        action: "manage team notes",
        description: `Review ${capability}`,
        authorityCategory: { domain: "files", verb: "manage", declaredBy: "workers/notes" },
        notability: "everyday",
      }),
    });

    expect(notableRows).toEqual([]);
    expect(everydayRows).toEqual([
      expect.objectContaining({
        notability: "everyday",
        timing: "on-add",
        selectable: true,
        row: expect.objectContaining({
          capability: "workspace-service:notes",
          action: "manage team notes",
          provenance: { source: "receiver" },
        }),
      }),
    ]);
  });

  it("contributes behavioral facts no capability row states", () => {
    const { notableRows } = installReviewRows({
      requests: [],
      behaviors: ["runs-on-schedule"],
    });
    expect(notableRows).toEqual([
      {
        kind: "behavior",
        key: "behavior:runs-on-schedule",
        fact: "runs-on-schedule",
        timing: "behavioral",
        notability: "headline",
        selectable: false,
        selectedByDefault: false,
      },
    ]);
  });

  it("carries an earlier decision across an update instead of re-asking or re-granting", () => {
    const previous = [request("workspace.files.write"), request("workspace.files.read")];
    const cleared = new Set([
      installRowKey({
        capability: "workspace.files.write",
        resourceScope: { kind: "prefix", prefix: "" },
      }),
    ]);
    const { everydayRows } = installReviewRows({
      requests: previous,
      previousRequests: previous,
      previouslyCleared: cleared,
    });

    expect(
      Object.fromEntries(
        everydayRows.map((r) => [
          r.kind === "permission" ? r.row.capability : r.key,
          r.selectedByDefault,
        ])
      )
    ).toEqual({ "workspace.files.write": true, "workspace.files.read": false });
  });

  it("produces no row when only code identity changed, and one row when authority did", () => {
    const stable = [request("workspace.files.write")];
    expect(
      installReviewRows({ requests: stable, previousRequests: stable }).everydayRows.every(
        (r) => r.change === undefined
      )
    ).toBe(true);

    const widened = installReviewRows({
      requests: [...stable, request("network.fetch", "gated", { kind: "network", value: "*" })],
      previousRequests: stable,
    });
    expect(widened.notableRows.map((r) => r.change)).toEqual(["added"]);

    const narrowed = installReviewRows({ requests: [], previousRequests: stable });
    expect(narrowed.everydayRows.map((r) => [r.change, r.selectable])).toEqual([
      ["removed", false],
    ]);
  });

  it("defaults a repair's new authority to unchecked, because the user did not ask for it", () => {
    const { everydayRows } = installReviewRows({
      requests: [request("workspace.files.write")],
      section: "repair",
    });
    expect(everydayRows[0]).toMatchObject({ selectable: true, selectedByDefault: false });
  });
});

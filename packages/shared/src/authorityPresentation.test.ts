import { describe, expect, it } from "vitest";
import {
  createCapabilityPresentationResolver,
  describeCapability,
  summarizeAuthorityManifest,
  summarizeAuthorityRequests,
} from "./authorityPresentation.js";
import {
  HOST_AUTHORITY_METHODS,
  HOST_CAPABILITY_CATEGORIES,
  HOST_SEMANTIC_PRESENTATIONS,
} from "./authority/hostAuthorityCatalog.generated.js";
import { capabilityDomain } from "./authority/authorityDomains.js";
import { HOST_SEMANTIC_CAPABILITY_COPY } from "./hostApprovalCopy.js";

const HOST_CAPABILITY_PRESENTATIONS = Object.fromEntries(
  Object.entries(HOST_AUTHORITY_METHODS)
    .filter(
      (
        entry
      ): entry is [
        string,
        (typeof HOST_AUTHORITY_METHODS)[keyof typeof HOST_AUTHORITY_METHODS] & {
          presentation: NonNullable<(typeof entry)[1]["presentation"]>;
        },
      ] => entry[1].presentation !== null
    )
    .map(([method, row]) => [method, row.presentation])
);

describe("authority request presentation", () => {
  it("has reviewed copy for every capability in the static authority census", () => {
    expect(
      Object.keys(HOST_CAPABILITY_CATEGORIES).filter(
        (capability) =>
          !HOST_SEMANTIC_CAPABILITY_COPY.some(({ prefix }) =>
            prefix.endsWith(":")
              ? capability.startsWith(prefix)
              : capability === prefix || capability.startsWith(`${prefix}:`)
          ) && !(capability in HOST_SEMANTIC_PRESENTATIONS)
      )
    ).toEqual([]);
  });

  it("has a reviewed category for every static semantic host capability", () => {
    expect(
      HOST_SEMANTIC_CAPABILITY_COPY.filter(({ prefix }) => !prefix.endsWith(":"))
        .filter(({ prefix }) => capabilityDomain(prefix) === null)
        .map(({ prefix }) => prefix)
    ).toEqual([]);
  });

  it("projects exact requests and highlights only rows added by the new version", () => {
    const previous = [
      {
        capability: "push.send",
        resource: { kind: "prefix" as const, prefix: "" },
        tier: "gated" as const,
        evidence: "intentional-broad" as const,
      },
    ];
    const requests = [
      ...previous,
      {
        capability: "open-external",
        resource: { kind: "prefix" as const, prefix: "" },
        tier: "gated" as const,
        evidence: "intentional-broad" as const,
      },
      {
        capability: "workspace-service:notes",
        resource: { kind: "exact" as const, key: "notes:one" },
        tier: "gated" as const,
        evidence: "exact" as const,
      },
    ];
    const result = summarizeAuthorityRequests(
      requests,
      previous,
      createCapabilityPresentationResolver(() => [
        {
          name: "notes",
          title: "Team Notes",
          action: "share team notes",
          description: "Shares notes with the team",
          presentation: { domain: "sharing", verb: "act" },
          source: "services/notes",
        },
      ])
    );
    expect(result.rows).toEqual([
      expect.objectContaining({ capability: "push.send", domain: "sharing" }),
      expect.objectContaining({ capability: "open-external", domain: "sharing" }),
      expect.objectContaining({
        capability: "workspace-service:notes",
        domain: "sharing",
        action: "share team notes",
        provenance: expect.objectContaining({ surface: "declared by services/notes" }),
      }),
    ]);
    expect(result.diff.added.map(({ capability }) => capability)).toEqual([
      "open-external",
      "workspace-service:notes",
    ]);
    expect(result.diff.unchanged.map(({ capability }) => capability)).toEqual(["push.send"]);
    expect(result.requests).toEqual(requests);
  });

  it("presents a tier change distinctly without inventing added or removed authority", () => {
    const resource = { kind: "exact" as const, key: "notes:one" };
    const previous = [
      {
        capability: "workspace-service:notes",
        resource,
        tier: "gated" as const,
        evidence: "exact" as const,
      },
    ];
    const result = summarizeAuthorityRequests(
      [
        {
          capability: "workspace-service:notes",
          resource,
          tier: "critical",
          evidence: "bounded-dynamic",
        },
      ],
      previous,
      createCapabilityPresentationResolver(() => [
        {
          name: "notes",
          action: "use team notes",
          presentation: { domain: "files", verb: "act" },
          source: "services/notes",
        },
      ])
    );
    expect(result.diff.retiered).toEqual([
      expect.objectContaining({
        before: expect.objectContaining({ tier: "gated" }),
        after: expect.objectContaining({ tier: "critical" }),
      }),
    ]);
    expect(result.diff.added).toEqual([]);
    expect(result.diff.removed).toEqual([]);
  });

  it("reviews the single installed-code authority vocabulary", () => {
    const scope = (capability: string) => ({
      capability,
      resource: { kind: "prefix" as const, prefix: "" },
      tier: "gated" as const,
      evidence: "intentional-broad" as const,
    });
    const result = summarizeAuthorityManifest(
      {
        requests: [scope("push.send")],
        provides: [],
      },
      {
        requests: [scope("open-external")],
        provides: [],
      }
    );

    expect(result.diff.removed).toEqual([expect.objectContaining({ capability: "open-external" })]);
    expect(result.diff.added).toEqual([
      expect.objectContaining({ capability: "push.send", domain: "sharing" }),
    ]);
  });

  it("uses the declaring provider's sealed vocabulary for userland capabilities", () => {
    const resolver = createCapabilityPresentationResolver(
      () => [],
      () => [
        {
          provider: "extensions/shell",
          definition: {
            name: "native.shell.execute",
            title: "Run a command",
            action: "run a command or open a terminal",
            tier: "gated",
            sensitivity: "write",
            resourceType: "native.shell",
            presentation: { domain: "computer", verb: "act" },
            notability: "headline",
            grantScopes: ["once", "session"],
          },
        },
      ]
    );

    expect(resolver("userland:extensions/shell/native.shell.execute#*", "panel")).toMatchObject({
      title: "Run a command",
      action: "run a command or open a terminal",
      authorityCategory: {
        domain: "computer",
        verb: "act",
        declaredBy: "extensions/shell",
      },
    });
  });

  it("uses reviewed user effects instead of host transport method names", () => {
    expect(describeCapability("service:workers.resolveService")).toMatchObject({
      title: "Use a workspace service",
      action: "use a workspace service",
    });
    expect(describeCapability("approvals.read")).toMatchObject({
      title: "View requests awaiting your decision",
      action: "view requests awaiting your decision",
    });
    expect(describeCapability("workspace-host.manage")).toMatchObject({
      action: "open and manage workspace apps",
    });
    expect(describeCapability("workspace-units.manage")).toMatchObject({
      action: "manage workspace apps, panels, workers, and extensions",
    });
    expect(describeCapability("workspace-units.publish")).toMatchObject({
      action: "publish workspace apps, panels, workers, and extensions",
    });
    expect(describeCapability("extensions.reload")).toMatchObject({
      action: "reload workspace extensions",
    });
    expect(describeCapability("channel.members.remove")).toMatchObject({
      action: "remove a person from a shared conversation",
    });
    expect(describeCapability("approvals.read", "panel").description).toContain("this panel");
    expect(describeCapability("approvals.read", "worker").description).toContain("this worker");
    expect(describeCapability("approvals.read", "worker").description).not.toContain("unit");
  });

  it("resolves manifest capabilities from the generated method census", () => {
    expect(describeCapability("context.clone")).toMatchObject({
      title: "Copy another task's workspace",
      action: "copy another task's workspace",
      authorityCategory: { domain: "files", verb: "act" },
    });
  });

  it("names the copy slot as a kind and resolves it before presentation", () => {
    const descriptions = Object.values(HOST_CAPABILITY_PRESENTATIONS).map(
      ({ description }) => description
    );
    expect(descriptions.some((description) => description.includes("{requesterKind}"))).toBe(true);
    expect(descriptions.every((description) => !description.includes("{requester}"))).toBe(true);
    expect(describeCapability("approvals.read", "panel").description).not.toContain("{");
  });

  it("keeps technical authority vocabulary out of every reviewed host presentation", () => {
    const banned =
      /\b(resolve|RPC|DO|dispatcher|capability|grant|scope|session|mission|eval|lineage|digest|attestation|client config|units?)\b/i;
    for (const [method, presentation] of Object.entries(HOST_CAPABILITY_PRESENTATIONS)) {
      expect(
        [presentation.title, presentation.action, presentation.description].join(" "),
        method
      ).not.toMatch(banned);
    }
    for (const { prefix, presentation } of HOST_SEMANTIC_CAPABILITY_COPY) {
      expect(
        [presentation.title, presentation.action, presentation.description].join(" "),
        prefix
      ).not.toMatch(banned);
    }
  });
});

import { describe, expect, it } from "vitest";
import {
  createCapabilityPresentationResolver,
  describeCapability,
  summarizeAuthorityManifest,
  summarizeAuthorityRequests,
} from "./authorityPresentation.js";
import {
  HOST_CAPABILITY_PRESENTATIONS,
  HOST_SEMANTIC_CAPABILITY_PRESENTATIONS,
} from "./authority/hostCapabilityPresentations.js";
import { HOST_SEMANTIC_CAPABILITY_COPY } from "./hostApprovalCopy.js";

describe("authority request presentation", () => {
  it("groups exact requests and highlights only scopes added by the new version", () => {
    const previous = [
      {
        capability: "notifications",
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
        { name: "notes", title: "Team Notes", description: "Shares notes with the team" },
      ])
    );
    expect(result.groups).toEqual([
      expect.objectContaining({ id: "network", addedCount: 1 }),
      expect.objectContaining({ id: "notifications", addedCount: 0 }),
      expect.objectContaining({
        id: "runtime",
        addedCount: 1,
        items: [
          expect.objectContaining({
            title: "Team Notes",
            description: "Shares notes with the team",
          }),
        ],
      }),
    ]);
    expect(result.requests).toEqual(requests);
  });

  it("treats a tier or evidence change as a new reviewed request", () => {
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
      previous
    );
    expect(result.groups).toEqual([expect.objectContaining({ id: "runtime", addedCount: 1 })]);
    expect(result.removedCount).toBe(1);
  });

  it("reviews eval ceilings separately and surfaces both additions and removals", () => {
    const scope = (capability: string) => ({
      capability,
      resource: { kind: "prefix" as const, prefix: "" },
      tier: "gated" as const,
      evidence: "intentional-broad" as const,
    });
    const result = summarizeAuthorityManifest(
      {
        requests: [],
        evalCeilings: [
          {
            audience: "eval",
            purpose: "tool-eval",
            capabilities: [scope("notifications")],
          },
        ],
      },
      {
        requests: [],
        evalCeilings: [
          {
            audience: "eval",
            purpose: "tool-eval",
            capabilities: [scope("workspace-service:notes")],
          },
        ],
      }
    );

    expect(result.eval).toEqual([
      expect.objectContaining({
        purpose: "tool-eval",
        label: "Code run by this tool",
        removedCount: 1,
        groups: [expect.objectContaining({ id: "notifications", addedCount: 1 })],
      }),
    ]);
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
    expect(describeCapability("channel.members.remove")).toMatchObject({
      action: "remove a person from a shared conversation",
    });
    expect(describeCapability("approvals.read", "panel").description).toContain("this panel");
    expect(describeCapability("approvals.read", "worker").description).toContain("this worker");
    expect(describeCapability("approvals.read", "worker").description).not.toContain("unit");
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
    for (const [capability, presentation] of Object.entries(
      HOST_SEMANTIC_CAPABILITY_PRESENTATIONS
    )) {
      expect(
        [presentation.title, presentation.action, presentation.description].join(" "),
        capability
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

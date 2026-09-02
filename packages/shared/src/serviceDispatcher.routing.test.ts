import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createVerifiedCaller,
  ServiceDispatcher,
  verifiedInitiatingUserId,
  verifiedInitiator,
} from "./serviceDispatcher.js";
import { testAuthority } from "./serviceDispatcherTestUtils.js";

describe("ServiceDispatcher ownership", () => {
  it("derives a complete compound identity for lifecycle-style authority targets", () => {
    const dispatcher = new ServiceDispatcher();
    dispatcher.registerService({
      name: "lifecycle",
      authority: { principals: ["code"] },
      methods: {
        activate: {
          args: z.tuple([z.object({ kind: z.string(), releaseId: z.string() })]),
          capability: "runtime.supervision.manage",
          tier: { tier: "gated", session: "family", rationale: "Starts admitted code" },
          presentation: {
            title: "Start a workspace service",
            action: "start a workspace service",
            description: "Start one admitted service release.",
            group: "runtime",
            authorityCategory: { domain: "automation", verb: "manage" },
          },
          authority: {
            requirement: {
              kind: "capability",
              principal: "code",
              capability: "runtime.supervision.manage",
            },
            resource: {
              kind: "argument-fields",
              index: 0,
              fields: ["kind", "releaseId"],
              prefix: "activate:",
            },
          },
        },
      },
      handler: vi.fn(),
    });

    expect(
      dispatcher.compileAuthorityPlanLeaf({
        service: "lifecycle",
        method: "activate",
        args: [{ kind: "app", releaseId: "task-board" }],
        use: "action",
      }).resource
    ).toEqual({ kind: "exact", key: "activate:app:task-board" });
  });

  it("presents the reviewed method and human target without enforcement prose", async () => {
    const dispatcher = new ServiceDispatcher();
    const capability = "runtime.supervision.manage";
    const request = vi.fn((_input: unknown) => ({
      acquisitionId: "acq:activate-task-board",
      ownerRuntimeId: "app:caller",
      snapshotDigest: "d".repeat(64),
      capability,
      resourceKey: "activate:app:task-board",
      tier: "gated" as const,
      cardType: "permission.gated" as const,
      renderedAction: "start a workspace service",
      pending: true,
    }));
    dispatcher.setAuthorityAcquirer({
      request,
      acquire: vi.fn(),
      consume: vi.fn(),
      invalidate: vi.fn(),
    });
    dispatcher.setAuthorityResolver(({ caller, resourceKey }) => {
      const resolved = testAuthority(caller, capability, resourceKey);
      return { ...resolved, grants: [] };
    });
    dispatcher.registerService({
      name: "lifecycle",
      authority: { principals: ["code"] },
      methods: {
        activate: {
          args: z.tuple([z.object({ kind: z.string(), releaseId: z.string() })]),
          capability,
          tier: { tier: "gated", session: "family", rationale: "Starts admitted code" },
          presentation: {
            title: "Start a workspace service",
            action: "start a workspace service",
            description: "Start one admitted service release.",
            group: "runtime",
            authorityCategory: { domain: "automation", verb: "manage" },
          },
          authority: {
            requirement: { kind: "capability", principal: "code", capability },
            resource: {
              kind: "argument-fields",
              index: 0,
              fields: ["kind", "releaseId"],
              prefix: "activate:",
              presentation: {
                type: "workspace-runtime",
                label: "App or service",
                displayField: "releaseId",
              },
            },
          },
        },
      },
      handler: vi.fn(),
    });
    dispatcher.markInitialized();
    const caller = createVerifiedCaller("app:caller", "app", {
      callerId: "app:caller",
      callerKind: "app",
      repoPath: "apps/caller",
      effectiveVersion: "ev-caller",
      requested: [{ capability, resource: { kind: "prefix", prefix: "" } }],
    });
    delete caller.codeApproved;

    await expect(
      dispatcher.dispatch({ caller }, "lifecycle", "activate", [
        { kind: "app", releaseId: "task-board" },
      ])
    ).rejects.toMatchObject({ code: "EACQUIRE" });
    expect(request).toHaveBeenCalledWith(
      expect.objectContaining({
        resource: { kind: "exact", key: "activate:app:task-board" },
        presentation: expect.objectContaining({
          title: "Start a workspace service",
          resource: {
            type: "workspace-runtime",
            label: "App or service",
            value: "task-board",
          },
        }),
        substance: expect.objectContaining({
          summary: "Start a workspace service: task-board",
        }),
      })
    );
    const requested = request.mock.calls[0]?.[0] as { substance?: unknown } | undefined;
    expect(requested?.substance).not.toHaveProperty("detail");
    expect(requested?.substance).not.toHaveProperty("facts");
  });

  it("seals receiver-reviewed semantics into compiled authority-plan leaves", () => {
    const dispatcher = new ServiceDispatcher();
    dispatcher.registerService({
      name: "mail",
      authority: { principals: ["code"] },
      methods: {
        send: {
          args: z.tuple([z.string()]),
          capability: "workspace-service:mail",
          tier: {
            tier: "gated",
            session: "codeOnly",
            rationale: "Send mail after ordinary approval",
          },
          presentation: {
            title: "Send mail",
            action: "send mail",
            description: "Send a message through the workspace mail service.",
            group: "communication",
            authorityCategory: {
              domain: "sharing",
              verb: "act",
              declaredBy: "workers/mail",
            },
          },
          authority: {
            requirement: {
              kind: "capability",
              principal: "code",
              capability: "workspace-service:mail",
            },
            resource: { kind: "argument", index: 0 },
          },
          access: { sensitivity: "write" },
        },
      },
      handler: vi.fn(),
    });

    expect(
      dispatcher.compileAuthorityPlanLeaf({
        service: "mail",
        method: "send",
        args: ["alice@example.com"],
        use: "action",
      })
    ).toMatchObject({
      capability: "workspace-service:mail",
      resource: { kind: "exact", key: "alice@example.com" },
      review: {
        action: "send mail",
        domain: "sharing",
        verb: "act",
        declaredBy: "workers/mail",
      },
    });
  });

  it("reports only explicitly registered local endpoints", () => {
    const dispatcher = new ServiceDispatcher();
    dispatcher.registerService({
      name: "local",
      authority: { principals: ["user", "code"] },
      methods: {},
      handler: vi.fn(),
    });
    expect(dispatcher.hasService("local")).toBe(true);
    expect(dispatcher.hasService("not-registered")).toBe(false);
  });

  it("separates the authenticated deputy from the verified initiating user", () => {
    const deputy = createVerifiedCaller("extension:shell", "extension", null, null, {
      userId: "system",
      handle: "system",
    });
    const initiator = createVerifiedCaller("panel:terminal", "panel", null, null, {
      userId: "usr_alice",
      handle: "alice",
    });

    expect(verifiedInitiator({ caller: deputy })).toBe(deputy);
    expect(verifiedInitiatingUserId({ caller: deputy })).toBe("system");
    expect(verifiedInitiator({ caller: deputy, authorizingCaller: initiator })).toBe(initiator);
    expect(verifiedInitiatingUserId({ caller: deputy, authorizingCaller: initiator })).toBe(
      "usr_alice"
    );
  });
});

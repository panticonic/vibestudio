import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createVerifiedCaller,
  ServiceDispatcher,
  verifiedInitiatingUserId,
  callerAccountUserId,
  verifiedInitiator,
} from "./serviceDispatcher.js";
import { testAuthority } from "./serviceDispatcherTestUtils.js";

describe("ServiceDispatcher ownership", () => {
  it("rejects disconnected websites before method lookup, argument parsing, or resource acquisition", async () => {
    const dispatcher = new ServiceDispatcher();
    const resolver = vi.fn();
    const acquire = vi.fn();
    dispatcher.setAuthorityResolver(resolver);
    dispatcher.setAuthorityAcquirer({
      request: vi.fn(),
      acquire,
      consume: vi.fn(),
      invalidate: vi.fn(),
    });
    const ctx = {
      caller: {
        ...createVerifiedCaller("browser:doc-1", "panel"),
        website: {
          subject: "website:site-1" as const,
          userId: "user:alice" as const,
          workspaceId: "project",
          origin: "https://example.com",
          connected: false,
          binding: { subject: "website:site-1" as const, generation: 0, documentId: "doc-1" },
        },
      },
    };
    for (const entry of [
      "dispatch",
      "preflightAuthority",
      "preauthorizeAuthority",
      "assertAuthority",
    ] as const) {
      await expect(dispatcher[entry](ctx, "unknown", "unknown", [null])).rejects.toMatchObject({
        code: "ECONNECTIONREQUIRED",
        errorKind: "access",
        errorData: {
          authorityFailure: {
            reasonCode: "connection-required",
            remediation: { kind: "connect-workspace" },
          },
        },
      });
    }
    expect(resolver).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
  });

  it("does not apply a disconnected initiator's website eligibility to a reviewed receiver", async () => {
    const dispatcher = new ServiceDispatcher();
    const handler = vi.fn(async () => "inspected");
    dispatcher.setAuthorityResolver(({ caller, capability, resourceKey }) =>
      testAuthority(caller, capability, resourceKey)
    );
    dispatcher.registerService({
      name: "internalTemplateSource",
      authority: { principals: ["code"] },
      methods: {
        inspect: {
          args: z.tuple([]),
          website: {
            kind: "closed",
            reason: "Only the reviewed template receiver uses this host operation.",
          },
          tier: {
            tier: "open",
            session: "family",
            rationale: "Inspect through the reviewed receiver.",
          },
        },
      },
      handler,
    });
    dispatcher.markInitialized();
    const caller = createVerifiedCaller("extension:templates", "extension");
    const authorizingCaller = {
      ...createVerifiedCaller("browser:retired", "panel"),
      website: {
        subject: "website:site-1" as const,
        userId: "user:alice" as const,
        workspaceId: "project",
        origin: "https://example.com",
        connected: false,
        binding: { subject: "website:site-1" as const, generation: 0, documentId: "retired" },
      },
    };
    await expect(
      dispatcher.dispatch({ caller, authorizingCaller }, "internalTemplateSource", "inspect", [])
    ).resolves.toBe("inspected");
    expect(handler).toHaveBeenCalledOnce();
    await expect(
      dispatcher.dispatch(
        {
          caller: {
            ...authorizingCaller,
            website: { ...authorizingCaller.website, connected: true },
          },
        },
        "internalTemplateSource",
        "inspect",
        []
      )
    ).rejects.toMatchObject({ code: "EACCES" });
    expect(handler).toHaveBeenCalledOnce();
  });

  it("derives a complete compound identity for lifecycle-style authority targets", () => {
    const dispatcher = new ServiceDispatcher();
    dispatcher.registerService({
      name: "lifecycle",
      authority: { principals: ["code"] },
      methods: {
        activate: {
          website: {
            kind: "eligible",
            rationale: "Explicit receiver policy for this test fixture.",
          } as const,
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
          website: {
            kind: "eligible",
            rationale: "Explicit receiver policy for this test fixture.",
          } as const,
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
          website: {
            kind: "eligible",
            rationale: "Explicit receiver policy for this test fixture.",
          } as const,
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
    // The synthetic system principal is not an account: an operation nobody
    // initiated is unattributed, never attributed to the infrastructure.
    expect(verifiedInitiatingUserId({ caller: deputy })).toBeUndefined();
    expect(verifiedInitiator({ caller: deputy, authorizingCaller: initiator })).toBe(initiator);
    expect(verifiedInitiatingUserId({ caller: deputy, authorizingCaller: initiator })).toBe(
      "usr_alice"
    );
  });

  it("attributes a relayed operation to the runtime's own account, not to the relay", () => {
    // A chat channel, a scheduler, any server-owned singleton: it carries a
    // person's request between two runtimes without becoming that person.
    const relay = createVerifiedCaller("do:workers/pubsub-channel", "do", null, null, {
      userId: "system",
      handle: "system",
    });
    const agent = createVerifiedCaller("do:workers/agent-worker", "do", null, null, {
      userId: "usr_alice",
      handle: "alice",
    });

    // The relay stays the authorizing principal — it really did carry the
    // call — but the account behind the effect is the agent's own owner.
    expect(verifiedInitiator({ caller: agent, authorizingCaller: relay })).toBe(relay);
    expect(verifiedInitiatingUserId({ caller: agent, authorizingCaller: relay })).toBe("usr_alice");
  });

  it("reports no account behind a caller that belongs to none", () => {
    const infrastructure = createVerifiedCaller("do:workers/model-settings", "do", null, null, {
      userId: "system",
      handle: "system",
    });
    const anonymous = createVerifiedCaller("panel:seeded", "panel");

    expect(callerAccountUserId(infrastructure)).toBeUndefined();
    expect(callerAccountUserId(anonymous)).toBeUndefined();
    expect(
      callerAccountUserId(
        createVerifiedCaller("shell:device", "shell", null, null, {
          userId: "usr_alice",
          handle: "alice",
        })
      )
    ).toBe("usr_alice");
  });
});

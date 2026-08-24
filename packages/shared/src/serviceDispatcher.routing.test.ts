import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createVerifiedCaller,
  ServiceDispatcher,
  verifiedInitiatingUserId,
  verifiedInitiator,
} from "./serviceDispatcher.js";

describe("ServiceDispatcher ownership", () => {
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

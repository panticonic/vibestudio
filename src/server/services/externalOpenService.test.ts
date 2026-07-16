import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { EventService } from "@vibestudio/shared/eventsService";
import { describe, expect, it, vi } from "vitest";
import { createExternalOpenService } from "./externalOpenService.js";

describe("externalOpenService", () => {
  const panelCaller = () => createVerifiedCaller("panel-1", "panel");

  it("emits the approved browser event and reports the dispatcher-owned decision", async () => {
    const eventService = new EventService();
    const emit = vi.spyOn(eventService, "emit");
    const service = createExternalOpenService({ eventService });

    await expect(
      service.handler(
        {
          caller: panelCaller(),
          authorityDecisions: new Map([["external-browser-open", "session"]]),
        },
        "openExternal",
        ["https://example.com/path?q=1#fragment"]
      )
    ).resolves.toEqual({ approvalDecision: "session" });
    expect(emit).toHaveBeenCalledWith("external-open:open", {
      url: "https://example.com/path?q=1",
      callerId: "panel-1",
      callerKind: "panel",
    });
  });

  it("attributes an eval-authorized open to the initiating caller", async () => {
    const eventService = new EventService();
    const emit = vi.spyOn(eventService, "emit");
    const service = createExternalOpenService({ eventService });
    const evalCaller = createVerifiedCaller("do:product/eval:EvalDO:scope", "do");
    const initiator = createVerifiedCaller("panel-initiator", "panel");

    await service.handler({ caller: evalCaller, authorizingCaller: initiator }, "openExternal", [
      "mailto:hello@example.com",
    ]);
    expect(emit).toHaveBeenCalledWith(
      "external-open:open",
      expect.objectContaining({ callerId: "panel-initiator", callerKind: "panel" })
    );
  });

  it("rejects non-browser schemes", async () => {
    const service = createExternalOpenService({ eventService: new EventService() });
    await expect(
      service.handler({ caller: panelCaller() }, "openExternal", ["file:///etc/passwd"])
    ).rejects.toThrow("openExternal only supports http(s) and mailto URLs");
  });

  it("validates OAuth redirect URIs before emitting the open", async () => {
    const eventService = new EventService();
    const emit = vi.spyOn(eventService, "emit");
    const service = createExternalOpenService({ eventService });
    const authorizeUrl = new URL("https://login.example.com/oauth/authorize");
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", "client-1");
    authorizeUrl.searchParams.set("redirect_uri", "http://localhost:1455/auth/callback");
    authorizeUrl.searchParams.set("state", "state-1");
    authorizeUrl.searchParams.set("code_challenge", "challenge-1");
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    await expect(
      service.handler({ caller: panelCaller() }, "openExternal", [
        authorizeUrl.toString(),
        { expectedRedirectUri: "http://localhost:1456/auth/callback" },
      ])
    ).rejects.toThrow("redirect_uri does not match");
    expect(emit).not.toHaveBeenCalled();

    await service.handler({ caller: panelCaller() }, "openExternal", [
      authorizeUrl.toString(),
      { expectedRedirectUri: "http://localhost:1455/auth/callback" },
    ]);
    expect(emit).toHaveBeenCalledTimes(1);
  });
});

import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { describe, expect, it, vi } from "vitest";
import { EventService } from "@vibestudio/shared/eventsService";
import { createExternalOpenService } from "./externalOpenService.js";

const panelCaller = () =>
  createVerifiedCaller("panel-1", "panel", {
    callerId: "panel-1",
    callerKind: "panel",
    repoPath: "panels/example",
    effectiveVersion: "version-1",
    executionDigest: "a".repeat(64),
    requested: [
      {
        capability: "external.open",
        resource: { kind: "origin", origin: "https://example.com" },
      },
    ],
    evalCeilings: [],
  });

describe("externalOpenService", () => {
  it("selects one semantic approval leaf for the exact destination", async () => {
    const service = createExternalOpenService({ eventService: new EventService() });
    const prepare = service.authorityPreparation?.["externalOpen.openExternal.target"];
    expect(prepare?.({ caller: panelCaller() }, ["https://example.com/path?q=1#fragment"])).toEqual(
      [
        expect.objectContaining({
          capability: "external.open",
          resourceKey: "https://example.com",
          challenge: expect.objectContaining({
            resource: expect.objectContaining({ value: "https://example.com" }),
          }),
        }),
      ]
    );
  });

  it("does not add an approval leaf for a host/user transport", async () => {
    const service = createExternalOpenService({ eventService: new EventService() });
    const prepare = service.authorityPreparation?.["externalOpen.openExternal.target"];
    expect(
      prepare?.({ caller: createVerifiedCaller("shell:main", "shell") }, [
        "https://example.com/path",
      ])
    ).toEqual([]);
  });

  it("emits only after dispatcher authority and returns the unified decision", async () => {
    const eventService = new EventService();
    const emit = vi.spyOn(eventService, "emit");
    const service = createExternalOpenService({ eventService });

    await expect(
      service.handler(
        {
          caller: panelCaller(),
          authorityDecisions: new Map([["external.open", "session"]]),
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

  it("rejects non-browser schemes before an approval can be prepared", async () => {
    const service = createExternalOpenService({ eventService: new EventService() });
    const prepare = service.authorityPreparation?.["externalOpen.openExternal.target"];
    expect(() => prepare?.({ caller: panelCaller() }, ["file:///etc/passwd"])).toThrow(
      "openExternal only supports http(s) and mailto URLs"
    );
  });

  it("validates OAuth redirect binding during preparation", async () => {
    const service = createExternalOpenService({ eventService: new EventService() });
    const prepare = service.authorityPreparation?.["externalOpen.openExternal.target"];
    const authorizeUrl = new URL("https://login.example.com/oauth/authorize");
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("client_id", "client-1");
    authorizeUrl.searchParams.set("redirect_uri", "http://localhost:1455/auth/callback");
    authorizeUrl.searchParams.set("state", "state-1");
    authorizeUrl.searchParams.set("code_challenge", "challenge-1");
    authorizeUrl.searchParams.set("code_challenge_method", "S256");

    expect(() =>
      prepare?.({ caller: panelCaller() }, [
        authorizeUrl.toString(),
        { expectedRedirectUri: "http://localhost:1456/auth/callback" },
      ])
    ).toThrow("redirect_uri does not match");
  });
});

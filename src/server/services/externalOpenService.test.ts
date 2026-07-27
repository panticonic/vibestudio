import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { createTestServiceDispatcher } from "@vibestudio/shared/serviceDispatcherTestUtils";
import { parseUnitAuthorityManifest } from "@vibestudio/shared/authorityManifest";
import { describe, expect, it, vi } from "vitest";
import { EventService } from "@vibestudio/shared/eventsService";
import internalDoExecutionCatalog from "../internalDOs/internalDoExecutionCatalog.json";
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

  it("preflights the prepared destination without requiring a receiver-selected requirement", async () => {
    const dispatcher = createTestServiceDispatcher();
    dispatcher.registerService(createExternalOpenService({ eventService: new EventService() }));
    dispatcher.markInitialized();
    const caller = createVerifiedCaller("panel-1", "panel", {
      callerId: "panel-1",
      callerKind: "panel",
      repoPath: "panels/example",
      effectiveVersion: "version-1",
      executionDigest: "a".repeat(64),
      requested: [
        {
          capability: "external.open",
          resource: { kind: "prefix", prefix: "" },
        },
      ],
    });

    await expect(
      dispatcher.preflightAuthority({ caller }, "externalOpen", "openExternal", [
        "https://example.com/settings",
      ])
    ).resolves.toMatchObject({
      decision: "allowed",
      leaves: [
        {
          capability: "service:externalOpen.openExternal",
          resourceKey: "external.open",
          status: "granted",
        },
        {
          capability: "external.open",
          resourceKey: "https://example.com",
          status: "granted",
        },
      ],
    });
  });

  it("preflights GitHub from the product EvalDO authority envelope", async () => {
    const dispatcher = createTestServiceDispatcher();
    dispatcher.registerService(createExternalOpenService({ eventService: new EventService() }));
    dispatcher.markInitialized();
    const evalAuthority = parseUnitAuthorityManifest(
      internalDoExecutionCatalog.classes.EvalDO,
      "EvalDO authority"
    );
    const runtimeId = "do:vibestudio/internal:EvalDO:agent-channel";
    const caller = createVerifiedCaller(runtimeId, "do", {
      callerId: runtimeId,
      callerKind: "do",
      repoPath: "vibestudio/internal",
      effectiveVersion: "version-1",
      executionDigest: "b".repeat(64),
      requested: evalAuthority.requests,
    });

    await expect(
      dispatcher.preflightAuthority({ caller }, "externalOpen", "openExternal", [
        "https://github.com/settings/personal-access-tokens/new",
      ])
    ).resolves.toMatchObject({
      decision: "allowed",
      leaves: [
        {
          capability: "service:externalOpen.openExternal",
          resourceKey: "external.open",
          status: "granted",
        },
        {
          capability: "external.open",
          resourceKey: "https://github.com",
          status: "granted",
        },
      ],
    });
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
      "openExternal refuses panel, file, data, and JavaScript URLs"
    );
  });

  it("scopes OS-protocol approvals to the exact scheme", () => {
    const service = createExternalOpenService({ eventService: new EventService() });
    const prepare = service.authorityPreparation?.["externalOpen.openExternal.target"];

    expect(prepare?.({ caller: panelCaller() }, ["tel:+4912345"])).toEqual([
      expect.objectContaining({
        capability: "external.open",
        resourceKey: "tel:",
        challenge: expect.objectContaining({
          resource: expect.objectContaining({ value: "tel:" }),
        }),
      }),
    ]);
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

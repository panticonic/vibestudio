import { describe, expect, it, vi } from "vitest";
import type { StoredCookie } from "@vibestudio/browser-data";

vi.mock("electron", () => ({
  session: {
    fromPartition: vi.fn(),
  },
}));

import { createBrowserSessionSyncService, toElectronCookie } from "./browserSessionSync.js";
import type { BrowserDataClient } from "@vibestudio/browser-data";
import type { EventService } from "@vibestudio/shared/eventsService";
import type { ServerClient } from "../serverClient.js";

function storedCookie(partial: Partial<StoredCookie>): StoredCookie {
  return {
    id: 1,
    name: "sid",
    value: "value",
    domain: "example.com",
    host_only: 1,
    path: "/",
    expiration_date: null,
    secure: 1,
    http_only: 1,
    same_site: "lax",
    source_scheme: "secure",
    source_port: 443,
    source_browser: null,
    created_at: 1,
    last_accessed: null,
    ...partial,
  };
}

function makeSyncService(workspaceConfig: unknown) {
  const eventService = {
    subscribe: vi.fn(),
    unsubscribe: vi.fn(),
  } as unknown as EventService;
  const serverClient = {
    call: vi.fn(async (service: string, method: string) => {
      if (service === "workspace" && method === "getConfig") return workspaceConfig;
      return undefined;
    }),
  } as unknown as ServerClient;
  const browserDataClient = {
    getCookies: vi.fn(async () => []),
  } as unknown as BrowserDataClient;
  const service = createBrowserSessionSyncService({
    eventService,
    serverClient,
    browserDataClient,
  });
  return { service, eventService, serverClient };
}

describe("createBrowserSessionSyncService (manifest-declared broker)", () => {
  it("subscribes to the declared broker's import-complete event", async () => {
    const { service, eventService, serverClient } = makeSyncService({
      id: "ws",
      extensions: [{ source: "extensions/browser-data" }],
      providers: { browserData: { extension: "extensions/browser-data" } },
    });

    await service.start!(vi.fn() as never);

    const expectedEvent = "extensions:@workspace-extensions/browser-data::import-complete";
    expect(eventService.subscribe).toHaveBeenCalledWith(
      expectedEvent,
      "browser-session-sync",
      expect.anything()
    );
    expect(serverClient.call).toHaveBeenCalledWith("events", "subscribe", [expectedEvent]);
  });

  it("disables cookie sync when the manifest declares no broker", async () => {
    const { service, eventService, serverClient } = makeSyncService({ id: "ws" });

    await service.start!(vi.fn() as never);

    expect(eventService.subscribe).not.toHaveBeenCalled();
    expect(serverClient.call).not.toHaveBeenCalledWith("events", "subscribe", expect.anything());
  });
});

describe("toElectronCookie", () => {
  it("preserves host-only cookies by omitting domain", () => {
    expect(toElectronCookie(storedCookie({ host_only: 1 }))).not.toHaveProperty("domain");
  });

  it("sets domain for domain cookies", () => {
    expect(toElectronCookie(storedCookie({ host_only: 0, domain: ".example.com" }))).toMatchObject({
      domain: ".example.com",
    });
  });
});

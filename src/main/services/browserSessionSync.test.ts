import { describe, expect, it, vi } from "vitest";
import type { StoredCookie } from "@vibestudio/browser-data";

vi.mock("electron", () => ({
  session: {
    fromPartition: vi.fn(),
  },
}));

import { createBrowserSessionSyncService, toElectronCookie } from "./browserSessionSync.js";
import type { BrowserDataClient } from "@vibestudio/browser-data";
import { encodeEventWatchRecord } from "@vibestudio/shared/events";
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
  const serverClient = {
    call: vi.fn(async (service: string, method: string) => {
      if (service === "workspace" && method === "getConfig") return workspaceConfig;
      return undefined;
    }),
    stream: vi.fn(
      async (_service: string, _method: string, args: unknown[]) =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                encodeEventWatchRecord({
                  kind: "watching",
                  events: args[0] as never,
                  epoch: "test-epoch",
                })
              );
            },
          })
        )
    ),
  } as unknown as ServerClient;
  const browserDataClient = {
    getCookies: vi.fn(async () => []),
  } as unknown as BrowserDataClient;
  const service = createBrowserSessionSyncService({
    serverClient,
    browserDataClient,
  });
  return { service, serverClient };
}

describe("createBrowserSessionSyncService (manifest-declared broker)", () => {
  it("subscribes to the declared broker's import-complete event", async () => {
    const { service, serverClient } = makeSyncService({
      id: "ws",
      extensions: [{ source: "extensions/browser-data" }],
      providers: { browserData: { extension: "extensions/browser-data" } },
    });

    await service.start!(vi.fn() as never);

    const expectedEvent = "extensions:@workspace-extensions/browser-data::import-complete";
    expect(serverClient.stream).toHaveBeenCalledWith(
      "events",
      "watch",
      [[expectedEvent], expect.any(String)],
      expect.objectContaining({ bodyIdleTimeoutMs: null })
    );
  });

  it("disables cookie sync when the manifest declares no broker", async () => {
    const { service, serverClient } = makeSyncService({ id: "ws" });

    await service.start!(vi.fn() as never);

    expect(serverClient.stream).not.toHaveBeenCalled();
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

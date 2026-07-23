import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserCookieInput, StoredCookie } from "@vibestudio/browser-data";

const electronMocks = vi.hoisted(() => ({
  fromPartition: vi.fn(),
}));

vi.mock("electron", () => ({
  session: { fromPartition: electronMocks.fromPartition },
}));

import {
  cookieContentHash,
  createBrowserCookieProjectionService,
  effectiveCookieContentHash,
  toElectronCookie,
} from "./browserCookieProjection.js";

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

function input(partial: Partial<BrowserCookieInput> = {}): BrowserCookieInput {
  return {
    name: "sid",
    value: "secret",
    domain: "example.test",
    hostOnly: true,
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "lax",
    sourceScheme: "secure",
    sourcePort: 443,
    ...partial,
  };
}

function stored(partial: Partial<StoredCookie> = {}): StoredCookie {
  const cookie = input(partial);
  return {
    ...cookie,
    encryptedValue: "ciphertext",
    revision: 3,
    contentHash: cookieContentHash(cookie),
    createdAt: 1,
    ...partial,
  };
}

describe("canonical browser cookie projection", () => {
  it("hashes canonical content deterministically and notices material changes", () => {
    expect(cookieContentHash(input())).toBe(cookieContentHash(input()));
    expect(cookieContentHash(input({ value: "other" }))).not.toBe(cookieContentHash(input()));
    expect(cookieContentHash(input({ domain: "EXAMPLE.TEST" }))).toBe(cookieContentHash(input()));
  });

  it("preserves host-only cookies by omitting Electron's domain field", () => {
    expect(toElectronCookie(stored({ hostOnly: true }))).not.toHaveProperty("domain");
  });

  it("sets Electron's domain field for domain cookies", () => {
    expect(toElectronCookie(stored({ hostOnly: false, domain: ".example.test" }))).toMatchObject({
      domain: ".example.test",
    });
  });

  it("preserves add-then-delete ordering before the outbox flushes", () => {
    const cookie = input();
    const key = { name: cookie.name, domain: cookie.domain, path: cookie.path };
    const put = { op: "put" as const, cookie, mutationId: "put-1" };
    expect(effectiveCookieContentHash(undefined, [put], key)).toBe(cookieContentHash(cookie));

    const remove = { op: "delete" as const, key, mutationId: "delete-1" };
    expect(effectiveCookieContentHash(undefined, [put, remove], key)).toBeNull();
  });

  it("never blocks service startup while the browser-data extension is unavailable", async () => {
    vi.useFakeTimers();
    const browserDataClient = {
      getBrowserEnvironment: vi
        .fn()
        .mockRejectedValue(new Error("Extension is not installed: browser-data")),
    };
    const onInitializing = vi.fn();
    const onUnavailable = vi.fn();
    const onReady = vi.fn();
    const service = createBrowserCookieProjectionService({
      browserDataClient: browserDataClient as never,
      serverClient: { stream: vi.fn(), call: vi.fn() } as never,
      hostId: "desktop:test",
      outboxRoot: "/tmp/unused-browser-projection-test",
      setActivePartition: vi.fn(),
      onInitializing,
      onUnavailable,
      onReady,
    });

    await expect(service.start?.(() => undefined)).resolves.toBeUndefined();
    expect(onInitializing).toHaveBeenCalledTimes(1);
    await vi.waitFor(() =>
      expect(browserDataClient.getBrowserEnvironment).toHaveBeenCalledTimes(1)
    );
    expect(onReady).not.toHaveBeenCalled();
    expect(onUnavailable).not.toHaveBeenCalled();

    await service.stop?.(undefined);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(browserDataClient.getBrowserEnvironment).toHaveBeenCalledTimes(1);
  });

  it("publishes a terminal browser-environment failure after startup returns", async () => {
    const unavailable = new Error("Signed-in account is required");
    const browserDataClient = {
      getBrowserEnvironment: vi.fn().mockRejectedValue(unavailable),
    };
    const onUnavailable = vi.fn();
    const service = createBrowserCookieProjectionService({
      browserDataClient: browserDataClient as never,
      serverClient: { stream: vi.fn(), call: vi.fn() } as never,
      hostId: "desktop:test",
      outboxRoot: "/tmp/unused-browser-projection-test",
      setActivePartition: vi.fn(),
      onUnavailable,
    });

    await expect(service.start?.(() => undefined)).resolves.toBeUndefined();
    await vi.waitFor(() => expect(onUnavailable).toHaveBeenCalledWith(unavailable));
    await service.stop?.(undefined);
  });

  it("attaches later when the browser-data extension becomes ready", async () => {
    vi.useFakeTimers();
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "browser-cookie-projection-"));
    const cookies = {
      on: vi.fn(),
      off: vi.fn(),
      get: vi.fn().mockResolvedValue([]),
      set: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    };
    electronMocks.fromPartition.mockReturnValue({ cookies });
    const browserDataClient = {
      getBrowserEnvironment: vi
        .fn()
        .mockRejectedValueOnce(new Error("Extension failed to start: browser-data"))
        .mockResolvedValue({
          workspaceId: "workspace-test",
          ownerUserId: "user-test",
          environmentKey: "environment-test",
        }),
      applyCookieMutations: vi.fn().mockResolvedValue(undefined),
      getCookieSnapshot: vi.fn().mockResolvedValue({ revision: 1, cookies: [] }),
    };
    const setActivePartition = vi.fn();
    const onReady = vi.fn();
    const onStopped = vi.fn();
    const service = createBrowserCookieProjectionService({
      browserDataClient: browserDataClient as never,
      serverClient: {
        stream: vi.fn(),
        call: vi.fn().mockResolvedValue(null),
      } as never,
      hostId: "desktop:test",
      outboxRoot: tempRoot,
      setActivePartition,
      onReady,
      onStopped,
    });

    try {
      await service.start?.(() => undefined);
      expect(onReady).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(3_000);
      await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
      expect(setActivePartition).toHaveBeenCalledWith(
        "persist:browser-environment:environment-test"
      );

      await service.stop?.(undefined);
      expect(onStopped).toHaveBeenCalledTimes(1);
      expect(setActivePartition).toHaveBeenLastCalledWith(null);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserCookieInput, StoredCookie } from "@vibestudio/browser-data";
import type { BrowserCookieJar } from "./chromiumCookieJar.js";

vi.mock("electron", () => ({
  session: { fromPartition: vi.fn() },
  WebContentsView: vi.fn(),
}));

import {
  cookieContentHash,
  createBrowserCookieProjectionService,
  effectiveCookieContentHash,
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

function fakeCookieJar(initial: BrowserCookieInput[] = []) {
  let current = [...initial];
  let changed: (() => void) | undefined;
  const set = async (cookie: BrowserCookieInput) => {
    const key = cookieIdentity(cookie);
    current = [...current.filter((entry) => cookieIdentity(entry) !== key), cookie];
    changed?.();
  };
  const jar: BrowserCookieJar = {
    start: vi.fn(async (listener: () => void) => {
      changed = listener;
    }),
    snapshot: vi.fn(async () => ({
      cookies: [...current],
      unsupportedOpaquePartitions: 0,
    })),
    set: vi.fn(set),
    remove: vi.fn(async (key) => {
      const identity = cookieIdentity(key);
      current = current.filter((entry) => cookieIdentity(entry) !== identity);
      changed?.();
    }),
    stop: vi.fn(async () => {}),
  };
  return {
    jar,
    set,
    current: () => current,
    changed: () => changed?.(),
  };
}

function cookieIdentity(cookie: {
  name: string;
  domain: string;
  path: string;
  partitionKey?: { topLevelSite: string; hasCrossSiteAncestor: boolean };
}): string {
  return JSON.stringify([cookie.name, cookie.domain, cookie.path, cookie.partitionKey ?? null]);
}

describe("canonical browser cookie projection", () => {
  it("hashes canonical content deterministically and notices material changes", () => {
    expect(cookieContentHash(input())).toBe(cookieContentHash(input()));
    expect(cookieContentHash(input({ value: "other" }))).not.toBe(cookieContentHash(input()));
    expect(cookieContentHash(input({ domain: "EXAMPLE.TEST" }))).toBe(cookieContentHash(input()));
    expect(cookieContentHash(input({ sourceScheme: "unset", sourcePort: 0 }))).toBe(
      cookieContentHash(input())
    );
  });

  it("includes the complete structured partition key in identity and content", () => {
    const partitioned = input({
      partitionKey: {
        topLevelSite: "https://top.example",
        hasCrossSiteAncestor: true,
      },
    });
    expect(cookieContentHash(partitioned)).not.toBe(cookieContentHash(input()));
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
    const createCookieJar = vi.fn(() => fakeCookieJar().jar);
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
      createCookieJar,
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
    expect(createCookieJar).not.toHaveBeenCalled();

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
      createCookieJar: vi.fn(() => fakeCookieJar().jar),
      onUnavailable,
    });

    await expect(service.start?.(() => undefined)).resolves.toBeUndefined();
    await vi.waitFor(() => expect(onUnavailable).toHaveBeenCalledWith(unavailable));
    await service.stop?.(undefined);
  });

  it("attaches later when the browser-data extension becomes ready", async () => {
    vi.useFakeTimers();
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "browser-cookie-projection-"));
    const { jar } = fakeCookieJar();
    const createCookieJar = vi.fn(() => jar);
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
      createCookieJar,
      onReady,
      onStopped,
    });

    try {
      await service.start?.(() => undefined);
      expect(onReady).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(3_000);
      await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
      expect(createCookieJar).toHaveBeenCalledWith("persist:browser-environment:environment-test");

      await service.stop?.(undefined);
      expect(onStopped).toHaveBeenCalledTimes(1);
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("removes a conflicting Secure cookie before projecting its insecure replacement", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "browser-cookie-projection-"));
    const desired = stored({
      value: "canonical",
      secure: false,
      sourceScheme: "non_secure",
      sourcePort: 80,
    });
    const { jar } = fakeCookieJar([input({ value: "old-secure", secure: true })]);
    const applyCookieMutations = vi.fn().mockResolvedValue({ revision: 1 });
    const browserDataClient = {
      getBrowserEnvironment: vi.fn().mockResolvedValue({
        workspaceId: "workspace-test",
        ownerUserId: "user-test",
        environmentKey: "environment-test",
      }),
      applyCookieMutations,
      getCookieSnapshot: vi.fn().mockResolvedValue({ revision: 1, cookies: [desired] }),
    };
    const onReady = vi.fn();
    const service = createBrowserCookieProjectionService({
      browserDataClient: browserDataClient as never,
      serverClient: {
        stream: vi.fn(),
        call: vi.fn().mockResolvedValue(null),
      } as never,
      hostId: "desktop:test",
      outboxRoot: tempRoot,
      createCookieJar: () => jar,
      onReady,
    });

    try {
      await service.start?.(() => undefined);
      await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));

      expect(jar.remove).toHaveBeenCalledWith({
        name: "sid",
        domain: "example.test",
        path: "/",
      });
      expect(vi.mocked(jar.remove).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(jar.set).mock.invocationCallOrder[0]!
      );
      expect(jar.set).toHaveBeenCalledWith(
        expect.objectContaining({ name: "sid", value: "canonical", secure: false })
      );
      expect(applyCookieMutations).not.toHaveBeenCalled();
      expect(onReady.mock.calls[0]?.[0].diagnostics()).toMatchObject({
        converged: true,
        mismatchCount: 0,
      });
    } finally {
      await service.stop?.(undefined);
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("materializes identical cookie triples independently in different partitions", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "browser-cookie-projection-"));
    const first = stored({
      partitionKey: {
        topLevelSite: "https://one.example",
        hasCrossSiteAncestor: true,
      },
    });
    const second = stored({
      value: "other",
      partitionKey: {
        topLevelSite: "https://two.example",
        hasCrossSiteAncestor: true,
      },
    });
    const state = fakeCookieJar();
    const onReady = vi.fn();
    const service = createBrowserCookieProjectionService({
      browserDataClient: {
        getBrowserEnvironment: vi.fn().mockResolvedValue({
          workspaceId: "workspace-test",
          ownerUserId: "user-test",
          environmentKey: "environment-test",
        }),
        applyCookieMutations: vi.fn().mockResolvedValue({ revision: 1 }),
        getCookieSnapshot: vi.fn().mockResolvedValue({ revision: 2, cookies: [first, second] }),
      } as never,
      serverClient: {
        stream: vi.fn(),
        call: vi.fn().mockResolvedValue(null),
      } as never,
      hostId: "desktop:test",
      outboxRoot: tempRoot,
      createCookieJar: () => state.jar,
      onReady,
    });

    try {
      await service.start?.(() => undefined);
      await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));

      expect(state.jar.set).toHaveBeenCalledTimes(2);
      expect(state.current()).toEqual(expect.arrayContaining([first, second]));
      expect(onReady.mock.calls[0]?.[0].diagnostics()).toMatchObject({
        converged: true,
        mismatchCount: 0,
      });
    } finally {
      await service.stop?.(undefined);
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("continues projecting later cookies when one cookie is rejected", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "browser-cookie-projection-"));
    const rejected = stored({ name: "a-rejected", domain: "bad.example" });
    const accepted = stored({ name: "b-accepted", domain: "good.example" });
    const state = fakeCookieJar();
    vi.mocked(state.jar.set).mockImplementation(async (cookie) => {
      if (cookie.name === rejected.name) {
        throw new Error("Chromium rejected this cookie");
      }
      await state.set(cookie);
    });
    const browserDataClient = {
      getBrowserEnvironment: vi.fn().mockResolvedValue({
        workspaceId: "workspace-test",
        ownerUserId: "user-test",
        environmentKey: "environment-test",
      }),
      applyCookieMutations: vi.fn().mockResolvedValue({ revision: 1 }),
      getCookieSnapshot: vi.fn().mockResolvedValue({ revision: 4, cookies: [rejected, accepted] }),
    };
    const onReady = vi.fn();
    const service = createBrowserCookieProjectionService({
      browserDataClient: browserDataClient as never,
      serverClient: {
        stream: vi.fn(),
        call: vi.fn().mockResolvedValue(null),
      } as never,
      hostId: "desktop:test",
      outboxRoot: tempRoot,
      createCookieJar: () => state.jar,
      onReady,
    });

    try {
      await service.start?.(() => undefined);
      await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));

      expect(state.jar.set).toHaveBeenCalledTimes(2);
      expect(state.current()).toEqual([
        expect.objectContaining({ name: accepted.name, value: accepted.value }),
      ]);
      expect(onReady.mock.calls[0]?.[0].diagnostics()).toMatchObject({
        converged: false,
        mismatchCount: 1,
        lastError: expect.stringContaining("1 write failures"),
      });
      await expect(onReady.mock.calls[0]?.[0].flush()).rejects.toThrow(
        "Cookie projection did not converge"
      );
      await new Promise((resolve) => setTimeout(resolve, 250));
      expect(browserDataClient.applyCookieMutations).not.toHaveBeenCalled();
    } finally {
      await service.stop?.(undefined);
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("captures browser-originated partitioned cookie changes with their complete identity", async () => {
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "browser-cookie-projection-"));
    const state = fakeCookieJar();
    const applyCookieMutations = vi.fn().mockResolvedValue({ revision: 1 });
    const onReady = vi.fn();
    const service = createBrowserCookieProjectionService({
      browserDataClient: {
        getBrowserEnvironment: vi.fn().mockResolvedValue({
          workspaceId: "workspace-test",
          ownerUserId: "user-test",
          environmentKey: "environment-test",
        }),
        applyCookieMutations,
        getCookieSnapshot: vi.fn().mockResolvedValue({ revision: 0, cookies: [] }),
      } as never,
      serverClient: {
        stream: vi.fn(),
        call: vi.fn().mockResolvedValue(null),
      } as never,
      hostId: "desktop:test",
      outboxRoot: tempRoot,
      createCookieJar: () => state.jar,
      onReady,
    });
    const browserCookie = input({
      partitionKey: {
        topLevelSite: "https://top.example",
        hasCrossSiteAncestor: true,
      },
    });

    try {
      await service.start?.(() => undefined);
      await vi.waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));

      await state.set(browserCookie);
      await vi.waitFor(() => expect(applyCookieMutations).toHaveBeenCalledTimes(1));
      expect(applyCookieMutations).toHaveBeenCalledWith({
        mutations: [
          expect.objectContaining({
            op: "put",
            cookie: browserCookie,
          }),
        ],
      });
    } finally {
      await service.stop?.(undefined);
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  it("pauses periodic reconciliation during a runtime generation transition and resumes on ready", async () => {
    vi.useFakeTimers();
    const tempRoot = await mkdtemp(path.join(os.tmpdir(), "browser-cookie-projection-"));
    const { jar } = fakeCookieJar();
    const getCookieSnapshot = vi.fn().mockResolvedValue({ revision: 1, cookies: [] });
    const encoder = new TextEncoder();
    let watchController: ReadableStreamDefaultController<Uint8Array> | null = null;
    const stream = vi.fn(
      async (
        _service: string,
        _method: string,
        _args: unknown[],
        options: { signal?: AbortSignal }
      ) => ({
        status: 200,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            watchController = controller;
            controller.enqueue(
              encoder.encode(
                `${JSON.stringify({ kind: "watching", events: ["server-health"], epoch: "e1" })}\n`
              )
            );
            options.signal?.addEventListener("abort", () => controller.close(), { once: true });
          },
        }),
      })
    );
    const onReady = vi.fn();
    const service = createBrowserCookieProjectionService({
      browserDataClient: {
        getBrowserEnvironment: vi.fn().mockResolvedValue({
          workspaceId: "workspace-test",
          ownerUserId: "user-test",
          environmentKey: "environment-test",
        }),
        applyCookieMutations: vi.fn().mockResolvedValue(undefined),
        getCookieSnapshot,
      } as never,
      serverClient: { stream, call: vi.fn().mockResolvedValue(null) } as never,
      hostId: "desktop:test",
      outboxRoot: tempRoot,
      createCookieJar: () => jar,
      onReady,
    });
    const pushHealth = (workerd: "restarting" | "running", sequence: number) => {
      watchController?.enqueue(
        encoder.encode(
          `${JSON.stringify({
            kind: "event",
            event: "server-health",
            payload: { workerd, sampledAt: Date.now() },
            sequence,
          })}\n`
        )
      );
    };

    try {
      await service.start?.(() => undefined);
      await vi.waitFor(() => expect(onReady).toHaveBeenCalledOnce());
      const initialReads = getCookieSnapshot.mock.calls.length;

      pushHealth("restarting", 1);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(getCookieSnapshot).toHaveBeenCalledTimes(initialReads);

      pushHealth("running", 2);
      await vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(() =>
        expect(getCookieSnapshot.mock.calls.length).toBeGreaterThan(initialReads)
      );
    } finally {
      await service.stop?.(undefined);
      await rm(tempRoot, { recursive: true, force: true });
    }
  });
});

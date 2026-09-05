import { describe, expect, it, vi } from "vitest";
import { request } from "node:http";
import { connect as netConnect } from "node:net";
import { parseConnectAuthority, EgressProxy } from "./egressProxy.js";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";

function caller() {
  return createVerifiedCaller("worker:connect-test", "worker", {
    callerId: "worker:connect-test",
    callerKind: "worker",
    repoPath: "/repo",
    effectiveVersion: "hash-1",
    executionDigest: "a".repeat(64),
    requested: [],
  });
}

function proxy(extra: Record<string, unknown> = {}) {
  const store = { loadUrlBound: vi.fn(() => null) };
  const instance = new EgressProxy({
    credentialStore: store,
    auditLog: { append: vi.fn() },
    ...extra,
  });
  return { instance, store };
}

function connectRequest(port: number, authority: string) {
  return new Promise<{ status: number; socket?: NodeJS.ReadableStream }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method: "CONNECT", path: authority });
    req.once("connect", (response, socket) =>
      resolve({ status: response.statusCode ?? 0, socket })
    );
    req.once("response", (response) => {
      response.resume();
      response.once("end", () => resolve({ status: response.statusCode ?? 0 }));
    });
    req.once("error", reject);
    req.end();
  });
}

describe("CONNECT egress boundary", () => {
  it("parses only exact hostname:port authority and canonicalizes IPv6", () => {
    expect(parseConnectAuthority("Example.COM:443")).toMatchObject({
      resource: "example.com:443",
      port: 443,
    });
    expect(parseConnectAuthority("[2001:db8::1]:8443")).toMatchObject({
      resource: "[2001:db8::1]:8443",
      port: 8443,
    });
    for (const value of [
      "",
      "example.com",
      "example.com:0",
      "example.com:65536",
      "user@example.com:443",
      "[::1]443",
    ]) {
      expect(() => parseConnectAuthority(value)).toThrow();
    }
  });

  it("uses network.connect approval and never consults matching HTTP credentials", async () => {
    const authorizeEffect = vi.fn(async () => {
      throw new Error("network.connect denied");
    });
    const { instance, store } = proxy({ authorizeEffect });
    const port = await instance.startForCaller(caller(), () => caller());
    try {
      const result = await connectRequest(port, "example.com:443");
      expect(result.status).toBe(403);
      expect(authorizeEffect).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ capability: "network.connect", method: "connect" })
      );
      expect(store.loadUrlBound).not.toHaveBeenCalled();
    } finally {
      await instance.stop();
    }
  });

  it("denies an approved private literal before dialing", async () => {
    const authorizeEffect = vi.fn(async () => undefined);
    const { instance } = proxy({ authorizeEffect });
    const port = await instance.startForCaller(caller(), () => caller());
    try {
      const result = await connectRequest(port, "127.0.0.1:9");
      expect(result.status).toBe(403);
      expect(authorizeEffect).toHaveBeenCalledOnce();
    } finally {
      await instance.stop();
    }
  });

  it("closes a pending CONNECT when its caller drops and ignores late approval", async () => {
    let approve!: () => void;
    const authorizeEffect = vi.fn(() => new Promise<void>((resolve) => (approve = resolve)));
    const { instance } = proxy({ authorizeEffect });
    const testCaller = caller();
    const port = await instance.startForCaller(testCaller, () => testCaller);
    const socket = netConnect({ host: "127.0.0.1", port });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once("connect", () => {
          socket.write("CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n");
          resolve();
        });
        socket.once("error", reject);
      });
      await vi.waitFor(() => expect(authorizeEffect).toHaveBeenCalledOnce());
      await instance.dropCaller(testCaller.runtime.id);
      approve();
      await new Promise<void>((resolve) => socket.once("close", () => resolve()));
      expect(socket.destroyed).toBe(true);
    } finally {
      socket.destroy();
      await instance.stop();
    }
  });

  it("shares one port for concurrent startup calls", async () => {
    const testCaller = caller();
    const { instance } = proxy();
    try {
      const [first, second] = await Promise.all([
        instance.startForCaller(testCaller, () => testCaller),
        instance.startForCaller(testCaller, () => testCaller),
      ]);
      expect(second).toBe(first);
    } finally {
      await instance.stop();
    }
  });

  it("denies a listener request when its live caller has disappeared", async () => {
    const testCaller = caller();
    let live: typeof testCaller | null = testCaller;
    const authorizeEffect = vi.fn(async () => undefined);
    const { instance } = proxy({ authorizeEffect });
    const port = await instance.startForCaller(testCaller, () => live);
    try {
      live = null;
      const result = await connectRequest(port, "example.com:443");
      expect(result.status).toBe(403);
      expect(authorizeEffect).not.toHaveBeenCalled();
    } finally {
      await instance.stop();
    }
  });

  it("destroys an accepted idle socket when stopping", async () => {
    const { instance } = proxy();
    const port = await instance.start();
    const socket = netConnect({ host: "127.0.0.1", port });
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
    await instance.stop();
    await closed;
    expect(socket.destroyed).toBe(true);
  });

  it("aborts a buffered fetch when its caller drops", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const authorizeEffect = vi.fn(() => new Promise<void>(() => {}));
    const { instance } = proxy({ authorizeEffect });
    const testCaller = caller();
    const pending = instance.forwardProxyFetch({
      caller: testCaller,
      url: "https://example.com/",
      method: "GET",
    });
    await vi.waitFor(() => expect(authorizeEffect).toHaveBeenCalledOnce());
    await instance.dropCaller(testCaller.runtime.id);
    await expect(
      Promise.race([
        pending,
        new Promise((_, reject) => setTimeout(() => reject(new Error("still pending")), 500)),
      ])
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("aborts credential approval and prevents a late grant from persisting", async () => {
    let resolveApproval!: (decision: string) => void;
    let approvalSignal: AbortSignal | undefined;
    const approvalQueue = {
      request: vi.fn((input: { signal?: AbortSignal }) => {
        approvalSignal = input.signal;
        return new Promise<string>((resolve) => (resolveApproval = resolve));
      }),
    };
    const saveUrlBound = vi.fn();
    const credential = {
      id: "cred-1",
      connectionId: "cred-1",
      label: "Example",
      owner: { sourceId: "/repo", sourceKind: "workspace", label: "/repo" },
      bindings: [
        {
          id: "api",
          use: "fetch",
          audience: [{ url: "https://api.example.com/", match: "path-prefix" }],
          injection: { type: "header", name: "authorization", valueTemplate: "Bearer {token}" },
        },
      ],
      grants: [],
      accessToken: "secret",
      scopes: [],
    };
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const testCaller = caller();
    const { instance } = proxy({
      credentialStore: { loadUrlBound: vi.fn(() => credential), saveUrlBound },
      approvalQueue,
    });
    const pending = instance.forwardProxyFetch({
      caller: testCaller,
      credentialId: "cred-1",
      url: "https://api.example.com/",
      method: "GET",
    });
    await vi.waitFor(() => expect(approvalSignal).toBeDefined());
    await instance.dropCaller(testCaller.runtime.id);
    expect(approvalSignal?.aborted).toBe(true);
    resolveApproval("version");
    await expect(pending).rejects.toThrow();
    expect(saveUrlBound).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

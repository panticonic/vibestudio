import { operationalErrorMetadata } from "@vibestudio/rpc";
import { describe, expect, it, vi } from "vitest";
import type { LookupAddress } from "node:dns";
import { setImmediate as immediate } from "node:timers/promises";
import {
  isPublicNetworkAddress,
  NetworkResolutionTimeoutError,
  resolveNetworkDestination,
} from "@vibestudio/shared/networkDestination";

const publicAddress = { address: "93.184.216.34", family: 4 as const };

describe("network destination policy", () => {
  it("rejects private, link-local, mapped, transition, and documentation ranges", () => {
    for (const address of [
      "0.0.0.0",
      "10.1.2.3",
      "100.64.1.2",
      "127.0.0.1",
      "169.254.1.2",
      "172.20.1.2",
      "192.0.2.1",
      "192.168.1.2",
      "198.18.1.2",
      "198.51.100.1",
      "203.0.113.1",
      "224.0.0.1",
      "::1",
      "fe80::1",
      "fc00::1",
      "2001:db8::1",
      "2002::1",
      "::ffff:192.168.1.2",
      "::ffff:127.0.0.1",
    ]) {
      expect(isPublicNetworkAddress(address, [])).toBe(false);
    }
  });

  it("denies globally routable addresses assigned to a host interface, including mapped spelling", () => {
    expect(isPublicNetworkAddress("8.8.8.8", ["8.8.8.8"])).toBe(false);
    expect(isPublicNetworkAddress("::ffff:8.8.8.8", ["8.8.8.8"])).toBe(false);
    expect(isPublicNetworkAddress("8.8.8.8", ["::ffff:8.8.8.8"])).toBe(false);
    expect(isPublicNetworkAddress("8.8.4.4", ["8.8.8.8", "fe80::1"])).toBe(true);
  });

  it("accepts public addresses and rejects a mixed DNS answer", async () => {
    const resolve = vi.fn(async () => [publicAddress]);
    await expect(
      resolveNetworkDestination(
        new URL("https://example.test/"),
        { kind: "public" },
        new AbortController().signal,
        resolve,
        []
      )
    ).resolves.toMatchObject({ hostname: "example.test", addresses: [publicAddress] });

    await expect(
      resolveNetworkDestination(
        new URL("https://mixed.test/"),
        { kind: "public" },
        new AbortController().signal,
        async () => [publicAddress, { address: "192.168.1.2", family: 4 }],
        []
      )
    ).rejects.toThrow("outside the authorized address space");
  });

  it("pins the resolver result and never resolves again", async () => {
    const resolve = vi.fn(async () => [publicAddress]);
    const destination = await resolveNetworkDestination(
      new URL("https://example.test/"),
      { kind: "public" },
      new AbortController().signal,
      resolve,
      []
    );
    const lookup = (options: { all?: boolean; family?: number }) =>
      new Promise<unknown>((resolveLookup, reject) => {
        destination.lookup("example.test", options, (error, address, family) =>
          error ? reject(error) : resolveLookup({ address, family })
        );
      });

    await expect(lookup({})).resolves.toEqual({ address: publicAddress.address, family: 4 });
    expect(resolve).toHaveBeenCalledTimes(1);
    await expect(
      new Promise((resolveLookup) =>
        destination.lookup("other.test", {}, (error) => resolveLookup(error?.message))
      )
    ).resolves.toBe("Network destination is no longer authorized");
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("rejects a lookup callback for an invalid hostname", async () => {
    const destination = await resolveNetworkDestination(
      new URL("https://example.test/"),
      { kind: "public" },
      new AbortController().signal,
      async () => [publicAddress],
      []
    );
    await expect(
      new Promise((resolveLookup) =>
        destination.lookup("bad name", {}, (error) => resolveLookup(error?.message))
      )
    ).resolves.toBe("Network destination is no longer authorized");
  });

  it("requires the exact origin for loopback authority", async () => {
    const signal = new AbortController().signal;
    await expect(
      resolveNetworkDestination(
        new URL("http://127.0.0.1:8787/"),
        { kind: "internal-loopback", origin: "http://127.0.0.1:8787" },
        signal,
        undefined,
        []
      )
    ).resolves.toBeDefined();
    await expect(
      resolveNetworkDestination(
        new URL("http://127.0.0.1:8787/"),
        { kind: "internal-loopback", origin: "http://127.0.0.1:8788" },
        signal,
        undefined,
        []
      )
    ).rejects.toThrow("does not match destination");
  });

  it("honors abort before and after DNS resolution", async () => {
    const before = new AbortController();
    before.abort();
    const resolve = vi.fn(async () => [publicAddress]);
    await expect(
      resolveNetworkDestination(
        new URL("https://example.test/"),
        { kind: "public" },
        before.signal,
        resolve,
        []
      )
    ).rejects.toThrow();
    expect(resolve).not.toHaveBeenCalled();

    const after = new AbortController();
    let release!: (addresses: LookupAddress[]) => void;
    const pending = new Promise<LookupAddress[]>((resolvePending) => (release = resolvePending));
    const resolving = resolveNetworkDestination(
      new URL("https://example.test/"),
      { kind: "public" },
      after.signal,
      () => pending,
      []
    );
    after.abort();
    release([publicAddress]);
    await expect(resolving).rejects.toThrow();

    const never = new AbortController();
    const neverResolves = resolveNetworkDestination(
      new URL("https://never.test/"),
      { kind: "public" },
      never.signal,
      () => new Promise<LookupAddress[]>(() => {}),
      []
    );
    never.abort();
    await expect(neverResolves).rejects.toThrow();
  });

  it("recovers temporary DNS failure before returning a vetted pinned destination", async () => {
    const temporary = Object.assign(new Error("temporary resolution failure"), {
      code: "EAI_AGAIN",
    });
    const resolve = vi.fn().mockRejectedValueOnce(temporary).mockResolvedValue([publicAddress]);
    const destination = await resolveNetworkDestination(
      new URL("https://example.test/"),
      { kind: "public" },
      new AbortController().signal,
      resolve,
      []
    );
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(destination.addresses).toEqual([publicAddress]);
    await new Promise<void>((accept, reject) =>
      destination.lookup("example.test", {}, (error, address) => {
        if (error) reject(error);
        else {
          expect(address).toBe(publicAddress.address);
          accept();
        }
      })
    );
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("preserves the final temporary failure and bounds DNS attempts", async () => {
    const first = Object.assign(new Error("first"), { code: "EAI_AGAIN" });
    const final = Object.assign(new Error("last"), { code: "EAI_AGAIN", syscall: "getaddrinfo" });
    const resolve = vi.fn().mockRejectedValueOnce(first).mockRejectedValue(final);
    await expect(
      resolveNetworkDestination(
        new URL("https://example.test/"),
        { kind: "public" },
        new AbortController().signal,
        resolve,
        []
      )
    ).rejects.toBe(final);
    expect(resolve).toHaveBeenCalledTimes(3);
  });

  it("does not retry permanent DNS failures or explicit opt-out", async () => {
    for (const [code, options] of [
      ["ENOTFOUND", {}],
      ["EAI_AGAIN", { retryTransientDns: false }],
    ] as const) {
      const failure = Object.assign(new Error(code), { code });
      const resolve = vi.fn().mockRejectedValue(failure);
      await expect(
        resolveNetworkDestination(
          new URL("https://example.test/"),
          { kind: "public" },
          new AbortController().signal,
          resolve,
          [],
          options
        )
      ).rejects.toBe(failure);
      expect(resolve).toHaveBeenCalledTimes(1);
    }
  });

  it("cancels DNS backoff without starting another resolution", async () => {
    const controller = new AbortController();
    const reason = new Error("request owner cancelled");
    const temporary = Object.assign(new Error("temporary"), { code: "EAI_AGAIN" });
    const resolve = vi.fn().mockRejectedValue(temporary);
    const resolving = resolveNetworkDestination(
      new URL("https://example.test/"),
      { kind: "public" },
      controller.signal,
      resolve,
      []
    );
    await immediate();
    expect(resolve).toHaveBeenCalledTimes(1);
    controller.abort(reason);
    await expect(resolving).rejects.toBe(reason);
    expect(resolve).toHaveBeenCalledTimes(1);
  });

  it("still rejects every mixed/private answer after transient recovery", async () => {
    const temporary = Object.assign(new Error("temporary"), { code: "EAI_AGAIN" });
    const resolve = vi
      .fn()
      .mockRejectedValueOnce(temporary)
      .mockResolvedValue([publicAddress, { address: "127.0.0.1", family: 4 }]);
    await expect(
      resolveNetworkDestination(
        new URL("https://example.test/"),
        { kind: "public" },
        new AbortController().signal,
        resolve,
        []
      )
    ).rejects.toThrow("outside the authorized address space");
    expect(resolve).toHaveBeenCalledTimes(2);
  });
});

it("retains the exact existing resolver deadline as a typed preconnect failure", async () => {
  const deadline = new AbortController();
  const original = new DOMException("The operation was aborted due to timeout", "TimeoutError");
  const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
  let finish: ((rows: LookupAddress[]) => void) | undefined;
  const resolver = vi.fn(
    () =>
      new Promise<LookupAddress[]>((resolve) => {
        finish = resolve;
      })
  );
  const pending = resolveNetworkDestination(
    new URL("https://example.test/"),
    { kind: "public" },
    new AbortController().signal,
    resolver,
    []
  );
  try {
    await immediate();
    const rejected = expect(pending).rejects.toMatchObject({
      name: "NetworkResolutionTimeoutError",
      code: "ETIMEDOUT",
      syscall: "getaddrinfo",
      phase: "dns",
      cause: original,
    });
    deadline.abort(original);
    await rejected;
    expect(timeout).toHaveBeenCalledWith(10_000);
    expect(resolver).toHaveBeenCalledTimes(1);
    finish!([publicAddress]);
    await expect(pending).rejects.toBeInstanceOf(NetworkResolutionTimeoutError);
    const error = await pending.catch((error) => error);
    expect(operationalErrorMetadata(error)).toMatchObject({
      name: "NetworkResolutionTimeoutError",
      code: "ETIMEDOUT",
      syscall: "getaddrinfo",
      phase: "dns",
    });
  } finally {
    timeout.mockRestore();
  }
});

it("never relabels caller cancellation as a resolver timeout", async () => {
  const deadline = new AbortController(),
    owner = new AbortController();
  const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
  const original = new Error("Caller released the request");
  const pending = resolveNetworkDestination(
    new URL("https://example.test/"),
    { kind: "public" },
    owner.signal,
    async () => new Promise<LookupAddress[]>(() => {}),
    []
  );
  try {
    const rejected = expect(pending).rejects.toBe(original);
    owner.abort(original);
    deadline.abort(new DOMException("timeout", "TimeoutError"));
    await rejected;
  } finally {
    timeout.mockRestore();
  }
});

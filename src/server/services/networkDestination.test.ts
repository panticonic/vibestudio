import { describe, expect, it, vi } from "vitest";
import type { LookupAddress } from "node:dns";
import { isPublicNetworkAddress, resolveNetworkDestination } from "./networkDestination.js";

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
});

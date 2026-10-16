import { describe, expect, it } from "vitest";
import { ClientArtifactCache } from "./artifactCache.js";
import { ClientLaunchError } from "./errors.js";
import { MemoryStore, integrityOf, responseOf } from "./testing.js";

describe("ClientArtifactCache", () => {
  it("fetches, verifies and stores once, then serves from the store", async () => {
    const store = new MemoryStore();
    let fetches = 0;
    const cache = new ClientArtifactCache(store, async () => {
      fetches += 1;
      return responseOf("hello");
    });
    const integrity = await integrityOf("hello");
    const handle = await cache.ensure({ path: "/_c/b/main.mjs", integrity });
    expect(handle).toBe(`mem://${integrity}/main.mjs`);
    await cache.ensure({ path: "/_c/b/main.mjs", integrity });
    expect(fetches).toBe(1);
  });

  it("never stores bytes whose digest mismatches", async () => {
    const store = new MemoryStore();
    const cache = new ClientArtifactCache(store, async () => responseOf("tampered"));
    const integrity = await integrityOf("hello");
    await expect(cache.ensure({ path: "/a.mjs", integrity })).rejects.toMatchObject({
      code: "integrity-mismatch",
    });
    expect(store.writes).toBe(0);
    expect(await store.list()).toEqual([]);
  });

  it("reports a failed download and retries on the next request", async () => {
    const store = new MemoryStore();
    let ok = false;
    const cache = new ClientArtifactCache(store, async () =>
      ok ? responseOf("x") : responseOf("nope", 502)
    );
    const integrity = await integrityOf("x");
    await expect(cache.ensure({ path: "/a.js", integrity })).rejects.toBeInstanceOf(
      ClientLaunchError
    );
    ok = true;
    await cache.ensure({ path: "/a.js", integrity });
    expect(store.writes).toBe(1);
  });

  it("shares one flight between concurrent requests for the same integrity", async () => {
    const store = new MemoryStore();
    let fetches = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const cache = new ClientArtifactCache(store, async () => {
      fetches += 1;
      await gate;
      return responseOf("shared");
    });
    const integrity = await integrityOf("shared");
    const a = cache.ensure({ path: "/a.js", integrity });
    const b = cache.ensure({ path: "/b.js", integrity });
    release();
    expect(await a).toBe(await b);
    expect(fetches).toBe(1);
    expect(store.writes).toBe(1);
  });

  it("rejects non-sha256 integrity", async () => {
    const cache = new ClientArtifactCache(new MemoryStore(), async () => responseOf(""));
    await expect(cache.ensure({ path: "/a.js", integrity: "sha512-AAAA" })).rejects.toMatchObject({
      code: "unsupported-integrity",
    });
  });

  it("garbage-collects everything no retained build refers to", async () => {
    const store = new MemoryStore();
    const cache = new ClientArtifactCache(store, async (route) => responseOf(route));
    const [a, b, c] = await Promise.all(["/a", "/b", "/c"].map(integrityOf));
    for (const [path, integrity] of [["/a", a], ["/b", b], ["/c", c]] as const) {
      await cache.ensure({ path, integrity: integrity! });
    }
    const removed = await cache.retain(
      new Map([
        ["build-1", [a!]],
        ["build-2", [b!]],
      ])
    );
    expect(removed).toEqual([c]);
    expect((await store.list()).sort()).toEqual([a!, b!].sort());
  });
});

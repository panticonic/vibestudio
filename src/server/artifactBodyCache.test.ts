import { describe, expect, it } from "vitest";
import { ArtifactBodyCache } from "./artifactBodyCache.js";

describe("artifact body ownership", () => {
  it("bounds retained bytes across representations and reloads evicted immutable bodies", async () => {
    const cache = new ArtifactBodyCache(8);
    let loads = 0;
    const load = async () => {
      loads++;
      return Buffer.alloc(4);
    };
    await cache.get("a", load);
    await cache.get("b", load);
    await cache.get("a", load);
    await cache.get("c", load);
    expect(cache.retainedBytes).toBe(8);
    await cache.get("b", load);
    expect(loads).toBe(4);
    await cache.get("large", async () => Buffer.alloc(16));
    expect(cache.retainedBytes).toBe(8);
  });
  it("shares only in-flight oversized work and releases failures for a fresh read", async () => {
    const cache = new ArtifactBodyCache(0);
    let settle!: (body: Buffer) => void;
    const load = () =>
      new Promise<Buffer>((resolve) => {
        settle = resolve;
      });
    const first = cache.get("a", load);
    expect(cache.get("a", load)).toBe(first);
    await Promise.resolve();
    settle(Buffer.alloc(12));
    await first;
    expect(cache.retainedBytes).toBe(0);
    await expect(
      cache.get("a", async () => {
        throw new Error("read failed");
      })
    ).rejects.toThrow("read failed");
    await expect(cache.get("a", async () => Buffer.from("ok"))).resolves.toEqual(Buffer.from("ok"));
  });
});

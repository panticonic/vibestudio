import { mkdtemp, rm, stat, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClientArtifactCache } from "./artifactCache.js";
import { NodeArtifactStore } from "./nodeArtifactStore.js";
import { integrityOf, responseOf } from "./testing.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

async function store() {
  const base = await mkdtemp(join(tmpdir(), "client-store-"));
  roots.push(base);
  return { base, root: join(base, "cache"), store: new NodeArtifactStore(join(base, "cache")) };
}

describe("NodeArtifactStore", () => {
  it("writes atomically with private modes and round-trips list/read/locate/remove", async () => {
    const { root, store: s } = await store();
    const integrity = await integrityOf("module body");
    expect(await s.has(integrity)).toBe(false);
    await s.writeVerified(integrity, new TextEncoder().encode("module body"), "main.mjs");
    expect(await s.has(integrity)).toBe(true);
    expect(new TextDecoder().decode(await s.read(integrity))).toBe("module body");
    const located = await s.locate(integrity);
    expect(located.endsWith("main.mjs")).toBe(true);
    expect((await stat(located)).mode & 0o777).toBe(0o600);
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect(await s.list()).toEqual([integrity]);
    expect((await readdir(root)).some((e) => e.startsWith(".tmp-"))).toBe(false);
    await s.remove(integrity);
    expect(await s.list()).toEqual([]);
  });

  it("tolerates a concurrent writer of the same content", async () => {
    const { store: s } = await store();
    const integrity = await integrityOf("same");
    const bytes = new TextEncoder().encode("same");
    await Promise.all([1, 2, 3].map(() => s.writeVerified(integrity, bytes, "a.js")));
    expect(await s.list()).toEqual([integrity]);
  });

  it("backs a cache end to end", async () => {
    const { store: s } = await store();
    const cache = new ClientArtifactCache(s, async () => responseOf("body"));
    const handle = await cache.ensure({
      path: "/x/entry.mjs",
      integrity: await integrityOf("body"),
    });
    expect(handle.endsWith("entry.mjs")).toBe(true);
  });
});

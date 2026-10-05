import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TransportDerivativeCache } from "./transportDerivativeCache.js";

const roots: string[] = [];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-transport-cache-"));
  roots.push(root);
  const body = Buffer.from("immutable panel payload ".repeat(1024));
  const integrity = `sha256-${createHash("sha256").update(body).digest("hex")}`;
  return { root, body, integrity };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("TransportDerivativeCache", () => {
  it("publishes gzip and brotli derivatives that survive a new cache instance", async () => {
    const { root, body, integrity } = fixture();
    const cache = new TransportDerivativeCache(root);
    cache.schedule(integrity, body);

    await cache.close();
    const reader = new TransportDerivativeCache(root);
    const gzip = (await reader.get(integrity, "gzip"))!;
    const brotli = (await reader.get(integrity, "br"))!;
    await reader.close();

    expect(gunzipSync(gzip)).toEqual(body);
    expect(brotli.byteLength).toBeLessThan(body.byteLength);
  });

  it("loads file-backed sources only in the background derivative job", async () => {
    const { root, body, integrity } = fixture();
    const sourcePath = path.join(root, "source.js");
    fs.writeFileSync(sourcePath, body);
    const cache = new TransportDerivativeCache(path.join(root, "derivatives"));

    cache.scheduleFile(integrity, sourcePath);

    await cache.close();
    const reader = new TransportDerivativeCache(path.join(root, "derivatives"));
    const gzip = (await reader.get(integrity, "gzip"))!;
    await reader.close();
    expect(gunzipSync(gzip)).toEqual(body);
  });

  it("skips excess optional prewarming and joins admitted work", async () => {
    const { root, body, integrity } = fixture();
    const cache = new TransportDerivativeCache(root, 1);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    cache.schedule(integrity, body);
    const other = `sha256-${createHash("sha256").update("other").digest("hex")}`;
    cache.scheduleFile(other, path.join(root, "missing.js"));
    await cache.close();
    const reader = new TransportDerivativeCache(root);
    try {
      expect(gunzipSync((await reader.get(integrity, "gzip"))!)).toEqual(body);
      expect(await reader.get(other, "gzip")).toBeNull();
      expect(warning).not.toHaveBeenCalled();
      await expect(cache.get(integrity, "gzip")).rejects.toThrow(/closed/);
    } finally {
      await reader.close();
    }
  });

  it("propagates an admitted source failure at close", async () => {
    const { root, integrity } = fixture();
    const cache = new TransportDerivativeCache(root, 1);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    cache.scheduleFile(integrity, path.join(root, "missing.js"));
    await expect(cache.close()).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a derivative whose encoded bytes no longer match its metadata", async () => {
    const { root, body, integrity } = fixture();
    const cache = new TransportDerivativeCache(root);
    cache.schedule(integrity, body);
    await cache.close();

    const encodedPath = fs
      .readdirSync(path.join(root, `p1-br6-gzip6-${integrity.slice(7)}`))
      .map((name) => path.join(root, `p1-br6-gzip6-${integrity.slice(7)}`, name))
      .find((name) => name.endsWith("gzip.bin"));
    expect(encodedPath).toBeTruthy();
    fs.writeFileSync(encodedPath!, "corrupt");

    const reader = new TransportDerivativeCache(root);
    try {
      expect(await reader.get(integrity, "gzip")).toBeNull();
    } finally {
      await reader.close();
    }
  });
});

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { TransportDerivativeCache } from "./transportDerivativeCache.js";

const roots: string[] = [];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-transport-cache-"));
  roots.push(root);
  const body = Buffer.from("immutable panel payload ".repeat(1024));
  const integrity = `sha256-${createHash("sha256").update(body).digest("hex")}`;
  return { root, body, integrity };
}

async function waitFor(
  cache: TransportDerivativeCache,
  integrity: string,
  encoding: "br" | "gzip"
): Promise<Buffer> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await cache.get(integrity, encoding);
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${encoding} derivative`);
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("TransportDerivativeCache", () => {
  it("publishes gzip and brotli derivatives that survive a new cache instance", async () => {
    const { root, body, integrity } = fixture();
    const cache = new TransportDerivativeCache(root);
    cache.schedule(integrity, body);

    const gzip = await waitFor(new TransportDerivativeCache(root), integrity, "gzip");
    const brotli = await waitFor(new TransportDerivativeCache(root), integrity, "br");

    expect(gunzipSync(gzip)).toEqual(body);
    expect(brotli.byteLength).toBeLessThan(body.byteLength);
  });

  it("loads file-backed sources only in the background derivative job", async () => {
    const { root, body, integrity } = fixture();
    const sourcePath = path.join(root, "source.js");
    fs.writeFileSync(sourcePath, body);
    const cache = new TransportDerivativeCache(path.join(root, "derivatives"));

    cache.scheduleFile(integrity, sourcePath);

    const gzip = await waitFor(cache, integrity, "gzip");
    expect(gunzipSync(gzip)).toEqual(body);
  });

  it("rejects a derivative whose encoded bytes no longer match its metadata", async () => {
    const { root, body, integrity } = fixture();
    const cache = new TransportDerivativeCache(root);
    cache.schedule(integrity, body);
    await waitFor(cache, integrity, "gzip");

    const encodedPath = fs
      .readdirSync(path.join(root, integrity.slice(7, 9), integrity.slice(7)))
      .map((name) => path.join(root, integrity.slice(7, 9), integrity.slice(7), name))
      .find((name) => name.endsWith("gzip.bin"));
    expect(encodedPath).toBeTruthy();
    fs.writeFileSync(encodedPath!, "corrupt");

    expect(await cache.get(integrity, "gzip")).toBeNull();
  });
});

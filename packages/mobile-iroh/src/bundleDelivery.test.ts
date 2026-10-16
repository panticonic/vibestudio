import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ClientArtifactCache } from "@vibestudio/client-host-core/artifactCache";
import { ClientLaunchError } from "@vibestudio/client-host-core/errors";
import {
  ARTIFACT_WRITE_CHUNK_BYTES,
  createGatewayArtifactFetch,
  createMobileArtifactStore,
  type NativeArtifactStore,
} from "./bundleDelivery.js";

const integrityOf = (bytes: Uint8Array) =>
  `sha256-${createHash("sha256").update(bytes).digest("hex")}`;

/**
 * A native store with the contract of the real one: staged bytes are invisible
 * until a commit whose hash matches the declared integrity publishes them.
 */
function fakeNative() {
  const published = new Map<string, { bytes: Uint8Array; name: string }>();
  const staged = new Map<string, { integrity: string; name: string; chunks: Uint8Array[] }>();
  let next = 0;
  const native: NativeArtifactStore = {
    artifactHas: vi.fn(async (integrity) => published.has(integrity)),
    artifactBeginWrite: vi.fn(async (integrity, name) => {
      const id = `w${next++}`;
      staged.set(id, { integrity, name, chunks: [] });
      return id;
    }),
    artifactAppend: vi.fn(async (id, base64) => {
      staged.get(id)!.chunks.push(Uint8Array.from(Buffer.from(base64, "base64")));
    }),
    artifactCommit: vi.fn(async (id) => {
      const write = staged.get(id)!;
      staged.delete(id);
      const bytes = Buffer.concat(write.chunks);
      if (integrityOf(bytes) !== write.integrity) {
        throw Object.assign(new Error("staged bytes do not match the declared integrity"), {
          code: "integrity-mismatch",
        });
      }
      published.set(write.integrity, { bytes, name: write.name });
    }),
    artifactAbort: vi.fn(async (id) => {
      staged.delete(id);
    }),
    artifactList: vi.fn(async () => [...published.keys()]),
    artifactRemove: vi.fn(async (integrity) => {
      published.delete(integrity);
    }),
    artifactLocate: vi.fn(async (integrity) => {
      if (!published.has(integrity)) throw new Error("absent");
      return `/cache/${integrity}/${published.get(integrity)!.name}`;
    }),
    artifactRead: vi.fn(async (integrity) =>
      Buffer.from(published.get(integrity)!.bytes).toString("base64")
    ),
  };
  return { native, published, staged };
}

describe("mobile artifact store", () => {
  it("writes in bounded chunks, commits once and locates the published artifact", async () => {
    const { native, published, staged } = fakeNative();
    const store = createMobileArtifactStore(native);
    const bytes = new Uint8Array(ARTIFACT_WRITE_CHUNK_BYTES * 2 + 17).map((_, i) => i % 251);
    const integrity = integrityOf(bytes);

    await store.writeVerified(integrity, bytes, "index.bundle");

    expect(native.artifactAppend).toHaveBeenCalledTimes(3);
    expect(native.artifactCommit).toHaveBeenCalledTimes(1);
    expect(staged.size).toBe(0);
    expect(await store.has(integrity)).toBe(true);
    expect(await store.locate(integrity)).toBe(`/cache/${integrity}/index.bundle`);
    expect(Buffer.from(await store.read(integrity)).equals(Buffer.from(published.get(integrity)!.bytes))).toBe(
      true
    );
    expect(await store.list()).toEqual([integrity]);
    await store.remove(integrity);
    expect(await store.has(integrity)).toBe(false);
  });

  it("rejects bytes native does not accept and discards the staging", async () => {
    const { native, published, staged } = fakeNative();
    const store = createMobileArtifactStore(native);
    const bytes = new Uint8Array([1, 2, 3]);
    // Declared integrity of different bytes: the native commit refuses.
    const declared = integrityOf(new Uint8Array([9, 9, 9]));

    await expect(store.writeVerified(declared, bytes, "index.bundle")).rejects.toMatchObject({
      code: "integrity-mismatch",
    });
    expect(published.size).toBe(0);
    expect(staged.size).toBe(0);
    expect(native.artifactAbort).toHaveBeenCalledTimes(1);
  });

  it("keeps the write failure when the staging cannot be discarded either", async () => {
    const { native } = fakeNative();
    const writeFailure = new Error("disk full");
    native.artifactAppend = vi.fn(async () => {
      throw writeFailure;
    });
    native.artifactAbort = vi.fn(async () => {
      throw new Error("abort failed");
    });
    const store = createMobileArtifactStore(native);

    const failure = await store
      .writeVerified(integrityOf(new Uint8Array([1])), new Uint8Array([1]), "a")
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors[0]).toBe(writeFailure);
  });
});

describe("verified bundle loading", () => {
  const bundle = new TextEncoder().encode("__d(function(){/* the client */});");
  const integrity = integrityOf(bundle);
  const route = "/_a/build-1/android/index.bundle";

  function responseOf(bytes: Uint8Array, status = 200) {
    return {
      ok: status >= 200 && status < 300,
      status,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
    } as Response;
  }

  it("hands the host a path only for bytes whose digest matches the sealed integrity", async () => {
    const { native, published } = fakeNative();
    const cache = new ClientArtifactCache(createMobileArtifactStore(native), async () =>
      responseOf(bundle)
    );

    const handle = await cache.ensure({ path: route, integrity });

    expect(handle).toBe(`/cache/${integrity}/index.bundle`);
    expect(published.has(integrity)).toBe(true);
  });

  it("never stores tampered bytes: the cache refuses before native sees a write", async () => {
    const { native, published } = fakeNative();
    const tampered = new TextEncoder().encode("__d(function(){/* not the client */});");
    const cache = new ClientArtifactCache(createMobileArtifactStore(native), async () =>
      responseOf(tampered)
    );

    const failure = await cache.ensure({ path: route, integrity }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ClientLaunchError);
    expect((failure as ClientLaunchError).code).toBe("integrity-mismatch");
    expect(native.artifactBeginWrite).not.toHaveBeenCalled();
    expect(published.size).toBe(0);
    // A later launch fetches again rather than trusting the failed flight.
    await expect(cache.ensure({ path: route, integrity })).rejects.toBeInstanceOf(ClientLaunchError);
  });

  it("serves an already verified bundle without fetching it again", async () => {
    const { native } = fakeNative();
    const fetchArtifact = vi.fn(async () => responseOf(bundle));
    const cache = new ClientArtifactCache(createMobileArtifactStore(native), fetchArtifact);

    await cache.ensure({ path: route, integrity });
    await cache.ensure({ path: route, integrity });

    expect(fetchArtifact).toHaveBeenCalledTimes(1);
  });
});

describe("gateway artifact fetch", () => {
  it("fetches the route over the device session and exposes status and body", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.close();
      },
    });
    const streamReadable = vi.fn(async () => ({
      status: 200,
      statusText: "OK",
      headers: [],
      finalUrl: "",
      body,
    }));
    const fetchArtifact = createGatewayArtifactFetch({ streamReadable } as never);

    const response = await fetchArtifact("/_a/build-1/android/index.bundle");

    expect(response.ok).toBe(true);
    expect(response.status).toBe(200);
    expect(response.body).toBe(body);
    expect(streamReadable).toHaveBeenCalledWith(
      "main",
      expect.anything(),
      [{ path: "/_a/build-1/android/index.bundle", method: "GET" }]
    );
  });

  it("reports a failing status without a body read", async () => {
    const streamReadable = vi.fn(async () => ({
      status: 404,
      statusText: "Not Found",
      headers: [],
      finalUrl: "",
      body: new ReadableStream<Uint8Array>(),
    }));
    const fetchArtifact = createGatewayArtifactFetch({ streamReadable } as never);

    expect((await fetchArtifact("/_a/x/y")).ok).toBe(false);
  });
});

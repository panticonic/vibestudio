import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { createTestServiceDispatcher } from "@vibestudio/shared/serviceDispatcherTestUtils";
import { createBlobstoreService, ensureLayout, getBytes, putBytes } from "./blobstoreService.js";
import { createProtectedRefStore } from "./protectedRefStore.js";
import { WorkspaceVcs } from "../vcsHost/workspaceVcs.js";
import { retainedBlobDigests, retainBlob, withBlobContentLock } from "../storage/blobRetentions.js";

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "blob-retention-"));
  roots.push(root);
  const blobsDir = path.join(root, "blobs");
  ensureLayout(blobsDir);
  const vcs = new WorkspaceVcs({
    workspaceId: "workspace:test",
    blobsDir,
    workspaceRoot: path.join(root, "source"),
    contextProjectionsRoot: path.join(root, "contexts"),
    buildSourcesRoot: path.join(root, "builds"),
    refs: createProtectedRefStore({
      statePath: path.join(root, "refs"),
      gate: vi.fn(async () => undefined),
    }),
  });
  await vcs.attachGad({
    contentGcRoots: async () => ({ contentRoots: [], contentHashes: [] }),
  } as never);
  let epoch = 0;
  const gc = () => vcs.runGc({ minAgeMs: 0, epoch: ++epoch, executionSourceRoots: [] });
  const call = (callerId: string, method: string, input: unknown) => {
    // Fresh service/dispatcher each call also proves durable registry reopening.
    const dispatcher = createTestServiceDispatcher();
    dispatcher.registerService(createBlobstoreService({ blobsDir }).definition);
    dispatcher.markInitialized();
    return dispatcher.dispatch(
      { caller: createVerifiedCaller(callerId, "do") },
      "blobstore",
      method,
      [input]
    );
  };
  return { root, blobsDir, vcs, gc, call };
}

describe("retained workspace blobs", () => {
  it("survives GC and service reopening while any authenticated owner retains the bytes", async () => {
    const f = await fixture();
    const input = { base64: Buffer.from("painted scene").toString("base64"), owner: "scene" };
    const stored = (await f.call("do:images:one", "putRetained", input)) as {
      digest: string;
      size: number;
    };
    expect(await f.call("do:images:one", "putRetained", input)).toEqual(stored);
    await f.call("do:images:two", "retain", { digest: stored.digest, owner: "scene" });
    await f.call("do:images:one", "releaseRetention", { owner: "scene" });
    await f.call("do:images:one", "releaseRetention", { owner: "scene" });
    await f.gc();
    expect(await getBytes(f.blobsDir, stored.digest)).toEqual(Buffer.from("painted scene"));
    expect(retainedBlobDigests(f.blobsDir)).toEqual([stored.digest]);
    await f.call("do:images:two", "releaseRetention", { owner: "scene" });
    await f.gc();
    expect(await getBytes(f.blobsDir, stored.digest)).toBeNull();
  });

  it("does not let another caller release an owner or reuse it for different content", async () => {
    const f = await fixture();
    const stored = (await f.call("owner", "putRetained", { base64: "b25l", owner: "asset" })) as {
      digest: string;
    };
    await f.call("outsider", "releaseRetention", { owner: "asset" });
    await expect(
      f.call("owner", "putRetained", { base64: "dHdv", owner: "asset" })
    ).rejects.toThrow("different content");
    await f.gc();
    expect(await getBytes(f.blobsDir, stored.digest)).toEqual(Buffer.from("one"));
  });

  it("cannot retain a digest that exists only in another workspace", async () => {
    const a = await fixture();
    const b = await fixture();
    const stored = (await a.call("owner", "putRetained", { base64: "b25l", owner: "asset" })) as {
      digest: string;
    };
    await expect(
      b.call("owner", "retain", { digest: stored.digest, owner: "asset" })
    ).rejects.toThrow("absent from this workspace");
    expect(retainedBlobDigests(b.blobsDir)).toEqual([]);
  });

  it("rechecks retentions acquired after GC preflight", async () => {
    const f = await fixture();
    const pendingGc = await f.vcs.prepareGc({ minAgeMs: 0, epoch: 1, executionSourceRoots: [] });
    const stored = (await f.call("owner", "putRetained", { base64: "b25l", owner: "asset" })) as {
      digest: string;
    };
    await pendingGc.commit();
    expect(await getBytes(f.blobsDir, stored.digest)).toEqual(Buffer.from("one"));
  });

  it("serializes destructive GC with the write-to-retention interval", async () => {
    const f = await fixture();
    const gc = await f.vcs.prepareGc({ minAgeMs: 0, epoch: 1, executionSourceRoots: [] });
    let written!: () => void;
    const ready = new Promise<void>((resolve) => {
      written = resolve;
    });
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const storing = withBlobContentLock(f.blobsDir, async () => {
      const stored = await putBytes(f.blobsDir, Buffer.from("in flight"));
      written();
      await gate;
      retainBlob(f.blobsDir, "owner", "image", stored.digest);
      return stored;
    });
    await ready;
    const sweeping = gc.commit();
    finish();
    const [stored] = await Promise.all([storing, sweeping]);
    expect(await getBytes(f.blobsDir, stored.digest)).toEqual(Buffer.from("in flight"));
  });
});

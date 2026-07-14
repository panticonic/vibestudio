import { createTestServiceDispatcher } from "@vibestudio/shared/serviceDispatcherTestUtils";
import { createHash } from "crypto";
import { createServer, request as httpRequest, type Server } from "http";
import { promises as fsp } from "fs";
import * as path from "path";
import * as os from "os";
import { Readable } from "stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import {
  buildWorktreeManifest,
  manifestHashForEntries,
  EMPTY_STATE_HASH,
  type ManifestHashEntry,
  type WorktreeHashFile,
} from "@vibestudio/shared/contentTree/worktreeHash";
import { treeHashDigest } from "@vibestudio/shared/contentTree/treeObjects";
import { dedupeBlobNamespaceSync } from "../storage/blobCas.js";
import {
  blobPath,
  createBlobstoreService,
  diffTrees,
  ensureLayout,
  getBytes,
  getTree,
  hasTreeObject,
  listTree,
  materializeTree,
  mirrorWorktreeTree,
  putBytes,
  putTree,
  readFileAtTree,
  resolveTreePath,
} from "./blobstoreService.js";

interface TestServer {
  server: Server;
  baseUrl: string;
}

interface HttpResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

async function startBlobstoreServer(blobsDir: string): Promise<TestServer> {
  const service = createBlobstoreService({ blobsDir });
  await service.start?.();
  const putRoute = service.routes!.find((route) => route.path === "/blob")!;
  const getRoute = service.routes!.find((route) => route.path === "/blob/:digest")!;

  const server = createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", "http://local").pathname;
    const digestMatch = /^\/blob\/([^/]+)$/.exec(pathname);

    let handled: Promise<void> | void;
    if (req.method === "PUT" && pathname === "/blob") {
      handled = Promise.resolve(putRoute.handler(req, res, {}));
    } else if (req.method === "GET" && digestMatch) {
      handled = Promise.resolve(getRoute.handler(req, res, { digest: digestMatch[1]! }));
    } else {
      res.writeHead(404);
      res.end();
      return;
    }

    void Promise.resolve(handled).catch((error) => {
      if (!res.headersSent) res.writeHead(500);
      res.end(error instanceof Error ? error.message : String(error));
    });
  });

  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : 0);
    });
  });

  return { server, baseUrl: `http://127.0.0.1:${port}` };
}

async function stopServer(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function http(method: string, url: string, body?: Buffer | Readable): Promise<HttpResult> {
  return await new Promise<HttpResult>((resolve, reject) => {
    const req = httpRequest(new URL(url), { method }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => {
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
    });
    req.on("error", reject);
    if (body instanceof Readable) {
      body.on("error", reject);
      body.pipe(req);
    } else {
      req.end(body);
    }
  });
}

function repeatingReadable(totalBytes: number, chunkBytes = 64 * 1024): Readable {
  const chunk = Buffer.alloc(chunkBytes, 0x61);
  let remaining = totalBytes;
  return Readable.from(
    (async function* () {
      while (remaining > 0) {
        const next = Math.min(remaining, chunkBytes);
        remaining -= next;
        yield next === chunk.length ? chunk : chunk.subarray(0, next);
      }
    })()
  );
}

function digestForRepeatedByte(byte: number, totalBytes: number, chunkBytes = 64 * 1024): string {
  const hash = createHash("sha256");
  const chunk = Buffer.alloc(chunkBytes, byte);
  let remaining = totalBytes;
  while (remaining > 0) {
    const next = Math.min(remaining, chunkBytes);
    hash.update(next === chunk.length ? chunk : chunk.subarray(0, next));
    remaining -= next;
  }
  return hash.digest("hex");
}

describe("blobstoreService", () => {
  let rootDir: string;
  let blobsDir: string;

  beforeEach(async () => {
    rootDir = await fsp.mkdtemp(path.join(os.tmpdir(), "vibestudio-blobstore-"));
    blobsDir = path.join(rootDir, "blobs");
  });

  afterEach(async () => {
    await fsp.rm(rootDir, { recursive: true, force: true });
  });

  it("stores and fetches bytes by sha256 digest", async () => {
    const { server, baseUrl } = await startBlobstoreServer(blobsDir);
    try {
      const bytes = Buffer.from("sunny gosling", "utf8");
      const expectedDigest = createHash("sha256").update(bytes).digest("hex");

      const put = await http("PUT", `${baseUrl}/blob`, bytes);
      expect(put.status).toBe(200);
      expect(JSON.parse(put.body.toString("utf8"))).toEqual({
        digest: expectedDigest,
        size: bytes.length,
      });

      const get = await http("GET", `${baseUrl}/blob/${expectedDigest}`);
      expect(get.status).toBe(200);
      expect(get.body).toEqual(bytes);
      expect(get.headers["content-length"]).toBe(String(bytes.length));
      expect(get.headers["etag"]).toBe(`"${expectedDigest}"`);
      expect(get.headers["cache-control"]).toBe("max-age=31536000, immutable");
    } finally {
      await stopServer(server);
    }
  });

  it("deduplicates repeated PUTs and leaves no temp files", async () => {
    const { server, baseUrl } = await startBlobstoreServer(blobsDir);
    try {
      const bytes = Buffer.from("same content", "utf8");
      const first = JSON.parse((await http("PUT", `${baseUrl}/blob`, bytes)).body.toString("utf8"));
      const second = JSON.parse(
        (await http("PUT", `${baseUrl}/blob`, bytes)).body.toString("utf8")
      );

      expect(second).toEqual(first);
      await expect(fsp.readdir(path.join(blobsDir, "tmp"))).resolves.toEqual([]);
    } finally {
      await stopServer(server);
    }
  });

  it("uses one global CAS while preserving per-workspace blob membership", async () => {
    const previousGlobalCas = process.env["VIBESTUDIO_GLOBAL_BLOB_CAS_DIR"];
    try {
      const globalCas = path.join(rootDir, "global-cas");
      const workspaceA = path.join(rootDir, "workspace-a", "blobs");
      const workspaceB = path.join(rootDir, "workspace-b", "blobs");
      process.env["VIBESTUDIO_GLOBAL_BLOB_CAS_DIR"] = globalCas;
      const bytes = Buffer.from("shared workspace content", "utf8");

      const storedA = await putBytes(workspaceA, bytes);
      const storedB = await putBytes(workspaceB, bytes);
      const pathA = blobPath(workspaceA, storedA.digest);
      const pathB = blobPath(workspaceB, storedB.digest);
      const globalPath = blobPath(globalCas, storedA.digest);
      const [statA, statB, globalStat] = await Promise.all([
        fsp.stat(pathA),
        fsp.stat(pathB),
        fsp.stat(globalPath),
      ]);

      expect(storedB).toEqual(storedA);
      expect(statA.ino).toBe(globalStat.ino);
      expect(statB.ino).toBe(globalStat.ino);
      await fsp.unlink(pathA);
      await expect(getBytes(workspaceA, storedA.digest)).resolves.toBeNull();
      await expect(getBytes(workspaceB, storedB.digest)).resolves.toEqual(bytes);
    } finally {
      if (previousGlobalCas === undefined) delete process.env["VIBESTUDIO_GLOBAL_BLOB_CAS_DIR"];
      else process.env["VIBESTUDIO_GLOBAL_BLOB_CAS_DIR"] = previousGlobalCas;
    }
  });

  it("migrates independent workspace blob namespaces into the global CAS", async () => {
    const namespaceA = path.join(rootDir, "namespace-a");
    const namespaceB = path.join(rootDir, "namespace-b");
    const globalCas = path.join(rootDir, "global-cas");
    const bytes = Buffer.from("legacy duplicate blob", "utf8");
    const storedA = await putBytes(namespaceA, bytes);
    const storedB = await putBytes(namespaceB, bytes);
    const pathA = blobPath(namespaceA, storedA.digest);
    const pathB = blobPath(namespaceB, storedB.digest);
    expect((await fsp.stat(pathA)).ino).not.toBe((await fsp.stat(pathB)).ino);

    const first = dedupeBlobNamespaceSync(namespaceA, globalCas);
    const second = dedupeBlobNamespaceSync(namespaceB, globalCas);

    expect(first.alreadyShared).toBe(1);
    expect(second.linked).toBe(1);
    expect((await fsp.stat(pathA)).ino).toBe((await fsp.stat(pathB)).ino);
  });

  it("returns 404 for unknown digests and 400 for malformed digests", async () => {
    const { server, baseUrl } = await startBlobstoreServer(blobsDir);
    try {
      const unknown = "0".repeat(64);
      expect((await http("GET", `${baseUrl}/blob/${unknown}`)).status).toBe(404);
      expect((await http("GET", `${baseUrl}/blob/not-a-digest`)).status).toBe(400);
    } finally {
      await stopServer(server);
    }
  });

  it("streams large PUT bodies without retaining them in memory", async () => {
    const { server, baseUrl } = await startBlobstoreServer(blobsDir);
    try {
      const totalBytes = 32 * 1024 * 1024;
      const put = await http("PUT", `${baseUrl}/blob`, repeatingReadable(totalBytes));
      const body = JSON.parse(put.body.toString("utf8"));

      expect(put.status).toBe(200);
      expect(body).toEqual({
        digest: digestForRepeatedByte(0x61, totalBytes),
        size: totalBytes,
      });
    } finally {
      await stopServer(server);
    }
  }, 15_000);

  it("exposes metadata RPC, shell/server delete and list, and denies panel deletion", async () => {
    const { server, baseUrl } = await startBlobstoreServer(blobsDir);
    const service = createBlobstoreService({ blobsDir });
    const dispatcher = createTestServiceDispatcher();
    dispatcher.registerService(service.definition);
    dispatcher.markInitialized();

    try {
      const bytes = Buffer.from("rpc bytes", "utf8");
      const put = JSON.parse((await http("PUT", `${baseUrl}/blob`, bytes)).body.toString("utf8"));
      const digest = put.digest as string;

      await expect(
        dispatcher.dispatch(
          { caller: createVerifiedCaller("p1", "panel") },
          "blobstore",
          "delete",
          [digest]
        )
      ).rejects.toMatchObject({ code: "EACCES" });

      await expect(
        dispatcher.dispatch({ caller: createVerifiedCaller("p1", "panel") }, "blobstore", "has", [
          digest,
        ])
      ).resolves.toBe(true);

      const stat = await dispatcher.dispatch(
        { caller: createVerifiedCaller("w1", "worker") },
        "blobstore",
        "stat",
        [digest]
      );
      expect(stat).toMatchObject({ size: bytes.length });

      await expect(
        dispatcher.dispatch(
          { caller: createVerifiedCaller("shell", "shell") },
          "blobstore",
          "list",
          []
        )
      ).resolves.toContain(digest);

      await expect(
        dispatcher.dispatch(
          { caller: createVerifiedCaller("shell", "shell") },
          "blobstore",
          "list",
          [{ prefix: digest.slice(0, 8), limit: 10 }]
        )
      ).resolves.toEqual([digest]);

      await expect(
        dispatcher.dispatch(
          { caller: createVerifiedCaller("server", "server") },
          "blobstore",
          "delete",
          [digest]
        )
      ).resolves.toBe(true);
      await expect(
        dispatcher.dispatch(
          { caller: createVerifiedCaller("server", "server") },
          "blobstore",
          "has",
          [digest]
        )
      ).resolves.toBe(false);
    } finally {
      await stopServer(server);
    }
  });

  it("sweeps stale temp files on startup", async () => {
    const tmpDir = path.join(blobsDir, "tmp");
    await fsp.mkdir(tmpDir, { recursive: true });
    await fsp.writeFile(path.join(tmpDir, "stale.tmp"), "partial");

    const service = createBlobstoreService({ blobsDir });

    await expect(fsp.readdir(tmpDir)).resolves.toEqual(["stale.tmp"]);
    await service.start?.();

    await expect(fsp.readdir(tmpDir)).resolves.toEqual([]);
  });

  describe("getRange", () => {
    async function putViaRpc(digest: string, body: string): Promise<void> {
      const service = createBlobstoreService({ blobsDir });
      await service.start?.();
      const dispatcher = createTestServiceDispatcher();
      dispatcher.registerService(service.definition);
      dispatcher.markInitialized();
      const result = (await dispatcher.dispatch(
        { caller: createVerifiedCaller("w1", "worker") },
        "blobstore",
        "putText",
        [body]
      )) as { digest: string };
      expect(result.digest).toBe(digest);
    }

    function dispatchGetRange(digest: string, offset: number, length: number): Promise<unknown> {
      const service = createBlobstoreService({ blobsDir });
      const dispatcher = createTestServiceDispatcher();
      dispatcher.registerService(service.definition);
      dispatcher.markInitialized();
      return dispatcher.dispatch(
        { caller: createVerifiedCaller("w1", "worker") },
        "blobstore",
        "getRange",
        [digest, offset, length]
      );
    }

    it("returns a partial slice of a stored blob", async () => {
      const body = "The quick brown fox jumps over the lazy dog.";
      const digest = createHash("sha256").update(body, "utf8").digest("hex");
      await putViaRpc(digest, body);

      await expect(dispatchGetRange(digest, 4, 5)).resolves.toBe("quick");
      await expect(dispatchGetRange(digest, 0, 3)).resolves.toBe("The");
    });

    it("truncates at EOF when length overruns the blob", async () => {
      const body = "short text";
      const digest = createHash("sha256").update(body, "utf8").digest("hex");
      await putViaRpc(digest, body);

      await expect(dispatchGetRange(digest, 6, 999)).resolves.toBe("text");
    });

    it("returns an empty string when offset is past EOF", async () => {
      const body = "tiny";
      const digest = createHash("sha256").update(body, "utf8").digest("hex");
      await putViaRpc(digest, body);

      await expect(dispatchGetRange(digest, 100, 50)).resolves.toBe("");
    });

    it("returns null when the digest is unknown", async () => {
      const unknown = "0".repeat(64);
      await expect(dispatchGetRange(unknown, 0, 10)).resolves.toBeNull();
    });

    it("rejects oversized reads to bound memory", async () => {
      const body = "x";
      const digest = createHash("sha256").update(body, "utf8").digest("hex");
      await putViaRpc(digest, body);
      // 1 MiB > the 256 KiB hard cap.
      await expect(dispatchGetRange(digest, 0, 1024 * 1024)).rejects.toThrow(/too large/);
    });

    it("getRangeBytes returns base64-encoded raw bytes", async () => {
      // PNG magic header — non-text bytes that would mangle through
      // the UTF-8 getRange path.
      const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const digest = createHash("sha256").update(bytes).digest("hex");
      // Stage the binary blob via putBase64 (putText would re-encode
      // as UTF-8 and corrupt the bytes).
      const service = createBlobstoreService({ blobsDir });
      await service.start?.();
      const dispatcher = createTestServiceDispatcher();
      dispatcher.registerService(service.definition);
      dispatcher.markInitialized();
      await dispatcher.dispatch(
        { caller: createVerifiedCaller("w1", "worker") },
        "blobstore",
        "putBase64",
        [bytes.toString("base64")]
      );
      const result = (await dispatcher.dispatch(
        { caller: createVerifiedCaller("w1", "worker") },
        "blobstore",
        "getRangeBytes",
        [digest, 0, 8]
      )) as { bytesBase64: string };
      const decoded = Buffer.from(result.bytesBase64, "base64");
      expect(Array.from(decoded)).toEqual(Array.from(bytes));
    });
  });

  describe("tree objects", () => {
    /** Seed a file blob and return its digest. */
    async function seed(text: string): Promise<string> {
      ensureLayout(blobsDir);
      return (await putBytes(blobsDir, Buffer.from(text, "utf8"))).digest;
    }

    const file = (name: string, contentHash: string, mode = 33188): ManifestHashEntry => ({
      name,
      kind: "file",
      contentHash,
      mode,
    });
    const dir = (name: string, childHash: string): ManifestHashEntry => ({
      name,
      kind: "dir",
      childHash,
    });

    /**
     * Seed the canonical fixture tree, built bottom-up:
     *   README.md
     *   bin/run.sh          (executable)
     *   src/a.ts
     *   src/lib/util.ts
     */
    async function seedFixtureTree(): Promise<{
      rootTree: string;
      stateHash: string;
      digests: { readme: string; run: string; a: string; util: string };
      subtrees: { src: string; lib: string; bin: string };
    }> {
      const digests = {
        readme: await seed("# readme\n"),
        run: await seed("#!/bin/sh\necho hi\n"),
        a: await seed("export const a = 1;\n"),
        util: await seed("export const util = 2;\n"),
      };
      const lib = (await putTree(blobsDir, [file("util.ts", digests.util)])).treeHash;
      const src = (await putTree(blobsDir, [file("a.ts", digests.a), dir("lib", lib)])).treeHash;
      const bin = (await putTree(blobsDir, [file("run.sh", digests.run, 33261)])).treeHash;
      const root = await putTree(
        blobsDir,
        [file("README.md", digests.readme), dir("src", src), dir("bin", bin)],
        { root: true }
      );
      return {
        rootTree: root.treeHash,
        stateHash: root.stateHash!,
        digests,
        subtrees: { src, lib, bin },
      };
    }

    it("round-trips a tree and its hashes match the gad worktree-hash scheme exactly", async () => {
      const { rootTree, stateHash, digests, subtrees } = await seedFixtureTree();

      // The SAME tree built through the gad manifest scheme must produce the
      // SAME hashes — this is the compatibility contract that lets existing
      // gad state hashes address content-store trees.
      const manifest = buildWorktreeManifest([
        { path: "README.md", contentHash: digests.readme, mode: 33188 },
        { path: "bin/run.sh", contentHash: digests.run, mode: 33261 },
        { path: "src/a.ts", contentHash: digests.a, mode: 33188 },
        { path: "src/lib/util.ts", contentHash: digests.util, mode: 33188 },
      ]);
      expect(rootTree).toBe(manifest.rootHash);
      expect(stateHash).toBe(manifest.stateHash);
      expect(subtrees.src).toBe(manifest.subtreeHash("src"));
      expect(subtrees.lib).toBe(manifest.subtreeHash("src/lib"));
      expect(subtrees.bin).toBe(manifest.subtreeHash("bin"));

      // getTree returns codepoint-sorted entries; accepts manifest: and state: refs.
      const entries = await getTree(blobsDir, rootTree);
      expect(entries?.map((e) => e.name)).toEqual(["README.md", "bin", "src"]);
      expect(await getTree(blobsDir, stateHash)).toEqual(entries);
      // Unknown tree/state refs → null.
      expect(await getTree(blobsDir, `manifest:${"0".repeat(64)}`)).toBeNull();
      expect(await getTree(blobsDir, `state:${"0".repeat(64)}`)).toBeNull();
    });

    it("deduplicates structurally: identical entry lists collapse to one node blob (idempotent putTree)", async () => {
      const digest = await seed("shared body");
      const first = await putTree(blobsDir, [file("x.txt", digest)]);
      const second = await putTree(blobsDir, [file("x.txt", digest)]);
      expect(second.treeHash).toBe(first.treeHash);

      // The same subtree mounted twice shares one child hash — and the node
      // blob is an ordinary CAS blob (GC/list can see it).
      const parent = await putTree(blobsDir, [
        dir("left", first.treeHash),
        dir("right", first.treeHash),
      ]);
      const entries = await getTree(blobsDir, parent.treeHash);
      expect(entries).toEqual([
        { name: "left", kind: "dir", childHash: first.treeHash },
        { name: "right", kind: "dir", childHash: first.treeHash },
      ]);

      // Node blobs live in the same store keyed by the hash's hex suffix.
      const service = createBlobstoreService({ blobsDir });
      const dispatcher = createTestServiceDispatcher();
      dispatcher.registerService(service.definition);
      dispatcher.markInitialized();
      await expect(
        dispatcher.dispatch({ caller: createVerifiedCaller("p1", "panel") }, "blobstore", "has", [
          treeHashDigest(first.treeHash),
        ])
      ).resolves.toBe(true);
    });

    it("putTree sorts unsorted input and matches manifestHashForEntries", async () => {
      const d1 = await seed("one");
      const d2 = await seed("two");
      const unsortedEntries = [file("zz.txt", d2), file("aa.txt", d1)];
      const { treeHash } = await putTree(blobsDir, unsortedEntries);
      expect(treeHash).toBe(manifestHashForEntries(unsortedEntries));
      const entries = await getTree(blobsDir, treeHash);
      expect(entries?.map((e) => e.name)).toEqual(["aa.txt", "zz.txt"]);
    });

    it("rejects trees whose referenced objects are missing or invalid", async () => {
      const present = await seed("present");
      const absent = "12".repeat(32);
      // Missing file blob.
      await expect(putTree(blobsDir, [file("gone.txt", absent)])).rejects.toThrow(
        /missing file blob/
      );
      // Missing child tree object.
      await expect(
        putTree(blobsDir, [dir("child", `manifest:${"34".repeat(32)}`)])
      ).rejects.toThrow(/missing child tree object/);
      // A "dir" pointing at arbitrary attacker-written bytes is rejected:
      // the blob exists but is not a valid canonical tree node.
      const junk = await seed("not a tree node");
      await expect(putTree(blobsDir, [dir("evil", `manifest:${junk}`)])).rejects.toThrow(
        /not valid JSON|Corrupt tree node/
      );
      // Path-traversal / invalid names.
      for (const name of ["../evil", "a/b", ".", "..", "nul\0byte"]) {
        await expect(putTree(blobsDir, [file(name, present)])).rejects.toThrow(
          /Invalid tree entry name/
        );
      }
      // Duplicates and bad modes.
      await expect(putTree(blobsDir, [file("a", present), file("a", present)])).rejects.toThrow(
        /Duplicate/
      );
      await expect(putTree(blobsDir, [file("a", present, 0o644)])).rejects.toThrow(
        /Invalid file mode/
      );
    });

    it("listTree walks recursively, honours prefix and limit", async () => {
      const { rootTree, stateHash, digests, subtrees } = await seedFixtureTree();

      const all = await listTree(blobsDir, rootTree);
      expect(all?.map((e) => e.path)).toEqual([
        "README.md",
        "bin",
        "bin/run.sh",
        "src",
        "src/a.ts",
        "src/lib",
        "src/lib/util.ts",
      ]);
      // state: ref resolves to the same listing.
      expect(await listTree(blobsDir, stateHash)).toEqual(all);

      // Prefix narrows to a subtree; paths stay tree-relative from the root.
      const src = await listTree(blobsDir, rootTree, { prefix: "src" });
      expect(src).toEqual([
        { path: "src/a.ts", kind: "file", contentHash: digests.a, mode: 33188 },
        { path: "src/lib", kind: "dir", treeHash: subtrees.lib },
        { path: "src/lib/util.ts", kind: "file", contentHash: digests.util, mode: 33188 },
      ]);
      // A prefix naming a file lists exactly that file.
      expect(await listTree(blobsDir, rootTree, { prefix: "bin/run.sh" })).toEqual([
        { path: "bin/run.sh", kind: "file", contentHash: digests.run, mode: 33261 },
      ]);
      // Absent prefix → empty; unknown root → null; limit caps output.
      expect(await listTree(blobsDir, rootTree, { prefix: "nope" })).toEqual([]);
      expect(await listTree(blobsDir, `manifest:${"0".repeat(64)}`)).toBeNull();
      expect(await listTree(blobsDir, rootTree, { limit: 2 })).toHaveLength(2);
      // Traversal prefixes are rejected outright.
      await expect(listTree(blobsDir, rootTree, { prefix: "../x" })).rejects.toThrow(
        /Invalid tree entry name/
      );
    });

    it("readFileAtTree resolves nested paths to digests and rejects traversal", async () => {
      const { rootTree, stateHash, digests } = await seedFixtureTree();
      await expect(readFileAtTree(blobsDir, rootTree, "src/lib/util.ts")).resolves.toEqual({
        contentHash: digests.util,
        mode: 33188,
      });
      await expect(readFileAtTree(blobsDir, stateHash, "bin/run.sh")).resolves.toEqual({
        contentHash: digests.run,
        mode: 33261,
      });
      // A directory is not a file; absent paths are null; can't descend into a file.
      await expect(readFileAtTree(blobsDir, rootTree, "src")).resolves.toBeNull();
      await expect(readFileAtTree(blobsDir, rootTree, "src/missing.ts")).resolves.toBeNull();
      await expect(readFileAtTree(blobsDir, rootTree, "README.md/extra")).resolves.toBeNull();
      await expect(readFileAtTree(blobsDir, rootTree, "src/../README.md")).rejects.toThrow(
        /Invalid tree entry name/
      );
    });

    it("resolveTreePath resolves dirs to subtree hashes and files to content addresses (buildV2 EV semantics)", async () => {
      const { rootTree, stateHash, digests, subtrees } = await seedFixtureTree();

      // Dirs resolve to their manifest hash — the subtree hash buildV2 EVs
      // are derived from; identical to buildWorktreeManifest().subtreeHash.
      await expect(resolveTreePath(blobsDir, rootTree, "src")).resolves.toEqual({
        kind: "dir",
        treeHash: subtrees.src,
      });
      await expect(resolveTreePath(blobsDir, stateHash, "src/lib")).resolves.toEqual({
        kind: "dir",
        treeHash: subtrees.lib,
      });
      // Files resolve to their content hash + mode (exec bit preserved).
      await expect(resolveTreePath(blobsDir, rootTree, "bin/run.sh")).resolves.toEqual({
        kind: "file",
        contentHash: digests.run,
        mode: 33261,
      });
      // The empty path is the root tree itself.
      await expect(resolveTreePath(blobsDir, stateHash, "")).resolves.toEqual({
        kind: "dir",
        treeHash: rootTree,
      });

      // Byte-identical to the shared manifest hashing (the EV stability
      // contract: DO subtree hashes and content-store resolution agree).
      const manifest = buildWorktreeManifest([
        { path: "README.md", contentHash: digests.readme, mode: 33188 },
        { path: "bin/run.sh", contentHash: digests.run, mode: 33261 },
        { path: "src/a.ts", contentHash: digests.a, mode: 33188 },
        { path: "src/lib/util.ts", contentHash: digests.util, mode: 33188 },
      ]);
      for (const p of ["src", "src/lib", "bin"]) {
        const resolved = await resolveTreePath(blobsDir, rootTree, p);
        expect(resolved).toEqual({ kind: "dir", treeHash: manifest.subtreeHash(p)! });
      }
      expect(await resolveTreePath(blobsDir, rootTree, "src/a.ts")).toMatchObject({
        contentHash: manifest.subtreeHash("src/a.ts"),
      });

      // Absent paths, descent through a file, and a file used as a dir → null.
      await expect(resolveTreePath(blobsDir, rootTree, "missing")).resolves.toBeNull();
      await expect(resolveTreePath(blobsDir, rootTree, "src/missing.ts")).resolves.toBeNull();
      await expect(resolveTreePath(blobsDir, rootTree, "README.md/extra")).resolves.toBeNull();
      // Unknown root object → null; traversal segments rejected outright.
      await expect(
        resolveTreePath(blobsDir, `manifest:${"0".repeat(64)}`, "src")
      ).resolves.toBeNull();
      await expect(resolveTreePath(blobsDir, rootTree, "src/../README.md")).rejects.toThrow(
        /Invalid tree entry name/
      );
    });

    it("diffTrees reports added/removed/changed with Merkle skipping and type flips", async () => {
      const dOld = await seed("old body");
      const dNew = await seed("new body");
      const dKeep = await seed("keep");
      const dInner = await seed("inner");

      const keepLib = (await putTree(blobsDir, [file("keep.ts", dKeep)])).treeHash;
      // Tree A: shared/keep.ts, changed.txt(old), gone.txt, flip (file)
      const treeA = (
        await putTree(blobsDir, [
          dir("shared", keepLib),
          file("changed.txt", dOld),
          file("gone.txt", dKeep),
          file("flip", dOld),
        ])
      ).treeHash;
      // Tree B: shared/keep.ts (identical subtree), changed.txt(new, now exec),
      // fresh.txt, flip is now a DIRECTORY with inner.txt
      const flipDir = (await putTree(blobsDir, [file("inner.txt", dInner)])).treeHash;
      const treeB = (
        await putTree(blobsDir, [
          dir("shared", keepLib),
          file("changed.txt", dNew, 33261),
          file("fresh.txt", dKeep),
          dir("flip", flipDir),
        ])
      ).treeHash;

      const diff = await diffTrees(blobsDir, treeA, treeB);
      expect(diff.changed).toEqual([
        {
          path: "changed.txt",
          fromContentHash: dOld,
          toContentHash: dNew,
          fromMode: 33188,
          toMode: 33261,
        },
      ]);
      expect(diff.removed.map((e) => e.path).sort()).toEqual(["flip", "gone.txt"]);
      expect(diff.added.map((e) => e.path).sort()).toEqual(["flip/inner.txt", "fresh.txt"]);

      // Identical trees diff to nothing (and never read the subtree nodes).
      await expect(diffTrees(blobsDir, treeA, treeA)).resolves.toEqual({
        added: [],
        removed: [],
        changed: [],
      });
      // Missing roots are a hard error — the caller cannot claim a diff over
      // objects the store does not hold.
      await expect(diffTrees(blobsDir, treeA, `manifest:${"0".repeat(64)}`)).rejects.toThrow(
        /Tree object missing/
      );
      await expect(diffTrees(blobsDir, `state:${"0".repeat(64)}`, treeB)).rejects.toThrow(
        /Tree object missing/
      );
    });

    it("materializeTree projects the tree onto disk, hardlinking from the CAS", async () => {
      const { rootTree, digests } = await seedFixtureTree();
      const outDir = path.join(rootDir, "checkout");

      const first = await materializeTree(blobsDir, rootTree, outDir);
      expect(first).toEqual({ written: 4, unchanged: 0 });

      await expect(fsp.readFile(path.join(outDir, "README.md"), "utf8")).resolves.toBe(
        "# readme\n"
      );
      await expect(fsp.readFile(path.join(outDir, "src", "lib", "util.ts"), "utf8")).resolves.toBe(
        "export const util = 2;\n"
      );

      // Non-executables hardlink to the CAS inode.
      const casStat = await fsp.stat(
        path.join(
          blobsDir,
          "sha256",
          digests.readme.slice(0, 2),
          digests.readme.slice(2, 4),
          digests.readme.slice(4)
        )
      );
      const outStat = await fsp.stat(path.join(outDir, "README.md"));
      expect(outStat.ino).toBe(casStat.ino);

      // Executables are copied (own inode) with the exec bit set.
      const runStat = await fsp.stat(path.join(outDir, "bin", "run.sh"));
      const casRunStat = await fsp.stat(
        path.join(
          blobsDir,
          "sha256",
          digests.run.slice(0, 2),
          digests.run.slice(2, 4),
          digests.run.slice(4)
        )
      );
      expect(runStat.ino).not.toBe(casRunStat.ino);
      expect(runStat.mode & 0o111).not.toBe(0);
      expect(casRunStat.mode & 0o111).toBe(0);

      // Second run trusts existing files.
      await expect(materializeTree(blobsDir, rootTree, outDir)).resolves.toEqual({
        written: 0,
        unchanged: 4,
      });

      // Relative outDir and unknown trees are rejected.
      await expect(materializeTree(blobsDir, rootTree, "relative/dir")).rejects.toThrow(
        /absolute path/
      );
      await expect(materializeTree(blobsDir, `manifest:${"0".repeat(64)}`, outDir)).rejects.toThrow(
        /Tree object missing/
      );
    });

    it("materializeTree replaces same-size files whose content hash differs", async () => {
      const digest = await seed("right");
      const { treeHash } = await putTree(blobsDir, [file("same-size.txt", digest)]);
      const outDir = path.join(rootDir, "same-size-checkout");
      await fsp.mkdir(outDir, { recursive: true });
      await fsp.writeFile(path.join(outDir, "same-size.txt"), "wrong");

      await expect(materializeTree(blobsDir, treeHash, outDir)).resolves.toEqual({
        written: 1,
        unchanged: 0,
      });
      await expect(fsp.readFile(path.join(outDir, "same-size.txt"), "utf8")).resolves.toBe("right");
    });

    it("materializeTree with link:false copies non-executables too", async () => {
      const digest = await seed("copy me");
      const { treeHash } = await putTree(blobsDir, [file("copy.txt", digest)]);
      const outDir = path.join(rootDir, "copy-checkout");
      await materializeTree(blobsDir, treeHash, outDir, { link: false });
      const casStat = await fsp.stat(
        path.join(blobsDir, "sha256", digest.slice(0, 2), digest.slice(2, 4), digest.slice(4))
      );
      const outStat = await fsp.stat(path.join(outDir, "copy.txt"));
      expect(outStat.ino).not.toBe(casStat.ino);
      await expect(fsp.readFile(path.join(outDir, "copy.txt"), "utf8")).resolves.toBe("copy me");
    });

    it("materializeTree refuses to descend through a pre-existing symlinked subdir", async () => {
      const { rootTree } = await seedFixtureTree();
      const outDir = path.join(rootDir, "symlink-out");
      const outside = path.join(rootDir, "outside-target");
      await fsp.mkdir(outDir, { recursive: true });
      await fsp.mkdir(outside, { recursive: true });
      // Attacker pre-seeds a subdir component (the fixture has a "src" dir) as a
      // symlink pointing outside the tree — the walker must reject, not follow.
      await fsp.symlink(outside, path.join(outDir, "src"));

      await expect(materializeTree(blobsDir, rootTree, outDir)).rejects.toThrow(/symlink/);
      // No writes leaked through the symlink into the outside target.
      await expect(fsp.readdir(outside)).resolves.toEqual([]);
    });

    it("materializeTree refuses an exact symlink output directory", async () => {
      const { rootTree } = await seedFixtureTree();
      const outside = path.join(rootDir, "outside-exact-target");
      const outDir = path.join(rootDir, "symlink-exact-out");
      await fsp.mkdir(outside, { recursive: true });
      await fsp.symlink(outside, outDir);

      await expect(materializeTree(blobsDir, rootTree, outDir)).rejects.toThrow(/symlink output/);
      await expect(fsp.readdir(outside)).resolves.toEqual([]);
    });

    it("materializeTree resolves an outDir under a symlinked parent (no false positive)", async () => {
      const { rootTree } = await seedFixtureTree();
      const realParent = path.join(rootDir, "real-parent");
      const linkParent = path.join(rootDir, "link-parent");
      await fsp.mkdir(realParent, { recursive: true });
      // A legitimately symlinked *ancestor* (mirrors /tmp → /private/tmp on
      // macOS) is realpath-collapsed, not treated as an attack.
      await fsp.symlink(realParent, linkParent);
      const outDir = path.join(linkParent, "checkout");

      await expect(materializeTree(blobsDir, rootTree, outDir)).resolves.toEqual({
        written: 4,
        unchanged: 0,
      });
      await expect(
        fsp.readFile(path.join(realParent, "checkout", "src", "lib", "util.ts"), "utf8")
      ).resolves.toBe("export const util = 2;\n");
    });

    it("rejects crafted tree nodes on READ paths (raw-blob smuggling)", async () => {
      // An attacker can write arbitrary bytes as a blob; referencing them as a
      // tree must fail on every read path, including traversal names inside
      // an otherwise well-formed canonical node.
      const evilNode =
        '{"entries":[{"contentHash":"' +
        "ab".repeat(32) +
        '","kind":"file","mode":33188,"name":"../../escape"}],"kind":"dir"}';
      const evilDigest = await seed(evilNode);
      const evilRef = `manifest:${evilDigest}`;
      await expect(getTree(blobsDir, evilRef)).rejects.toThrow(/Invalid tree entry name/);
      await expect(listTree(blobsDir, evilRef)).rejects.toThrow(/Invalid tree entry name/);
      await expect(
        materializeTree(blobsDir, evilRef, path.join(rootDir, "evil-out"))
      ).rejects.toThrow(/Invalid tree entry name/);

      // Non-canonical node bytes (extra whitespace) are also rejected.
      const nonCanonical = await seed('{"entries": [], "kind": "dir"}');
      await expect(getTree(blobsDir, `manifest:${nonCanonical}`)).rejects.toThrow(/canonical/);
    });

    it("exposes the tree APIs over RPC with the blobstore policy (materializeTree admin-only)", async () => {
      const service = createBlobstoreService({ blobsDir });
      await service.start?.();
      const dispatcher = createTestServiceDispatcher();
      dispatcher.registerService(service.definition);
      dispatcher.markInitialized();
      const panel = { caller: createVerifiedCaller("p1", "panel") };
      const server = { caller: createVerifiedCaller("server", "server") };

      const { digest } = (await dispatcher.dispatch(panel, "blobstore", "putText", [
        "rpc tree body",
      ])) as { digest: string };

      // Panels can create and read trees…
      const put = (await dispatcher.dispatch(panel, "blobstore", "putTree", [
        [{ name: "hello.txt", kind: "file", contentHash: digest, mode: 33188 }],
        { root: true },
      ])) as { treeHash: string; stateHash?: string };
      expect(put.treeHash).toMatch(/^manifest:[0-9a-f]{64}$/);
      expect(put.stateHash).toMatch(/^state:[0-9a-f]{64}$/);

      await expect(
        dispatcher.dispatch(panel, "blobstore", "getTree", [put.treeHash])
      ).resolves.toEqual([{ name: "hello.txt", kind: "file", contentHash: digest, mode: 33188 }]);
      await expect(
        dispatcher.dispatch(panel, "blobstore", "listTree", [put.stateHash])
      ).resolves.toEqual([{ path: "hello.txt", kind: "file", contentHash: digest, mode: 33188 }]);
      await expect(
        dispatcher.dispatch(panel, "blobstore", "readFileAtTree", [put.treeHash, "hello.txt"])
      ).resolves.toEqual({ contentHash: digest, mode: 33188 });
      await expect(
        dispatcher.dispatch(panel, "blobstore", "diffTrees", [put.treeHash, put.treeHash])
      ).resolves.toEqual({ added: [], removed: [], changed: [] });

      // …but materializeTree writes outside the store: shell/server only.
      const outDir = path.join(rootDir, "rpc-out");
      await expect(
        dispatcher.dispatch(panel, "blobstore", "materializeTree", [put.treeHash, outDir])
      ).rejects.toMatchObject({ code: "EACCES" });
      await expect(
        dispatcher.dispatch(server, "blobstore", "materializeTree", [put.treeHash, outDir])
      ).resolves.toEqual({ written: 1, unchanged: 0 });

      // Wire-level junk is rejected by the schema before the handler runs.
      await expect(
        dispatcher.dispatch(panel, "blobstore", "getTree", ["not-a-hash"])
      ).rejects.toThrow();
      await expect(
        dispatcher.dispatch(panel, "blobstore", "putTree", [
          [{ name: "x", kind: "file", contentHash: digest, mode: 123 }],
        ])
      ).rejects.toThrow();
    });
  });

  describe("mirrorWorktreeTree", () => {
    const F = (path: string, contentHash: string, mode = 33188): WorktreeHashFile => ({
      path,
      contentHash,
      mode,
    });

    async function seed(text: string): Promise<string> {
      ensureLayout(blobsDir);
      return (await putBytes(blobsDir, Buffer.from(text, "utf8"))).digest;
    }

    it("mirrors a file listing into readable tree objects, hash-identical to the gad scheme", async () => {
      const a = await seed("alpha\n");
      const b = await seed("beta\n");
      const files = [F("README.md", a), F("src/lib/util.ts", b), F("src/run.sh", b, 33261)];
      const mirrored = await mirrorWorktreeTree(blobsDir, files);

      const manifest = buildWorktreeManifest(files);
      expect(mirrored.stateHash).toBe(manifest.stateHash);
      expect(mirrored.treeHash).toBe(manifest.rootHash);
      expect(await hasTreeObject(blobsDir, mirrored.stateHash)).toBe(true);
      expect(await hasTreeObject(blobsDir, mirrored.treeHash)).toBe(true);

      // The mirrored state is fully readable through the tree APIs.
      const listing = await listTree(blobsDir, mirrored.stateHash);
      expect(listing!.filter((e) => e.kind === "file")).toMatchObject([
        { path: "README.md", contentHash: a, mode: 33188 },
        { path: "src/lib/util.ts", contentHash: b, mode: 33188 },
        { path: "src/run.sh", contentHash: b, mode: 33261 },
      ]);
      expect(await readFileAtTree(blobsDir, mirrored.stateHash, "src/lib/util.ts")).toEqual({
        contentHash: b,
        mode: 33188,
      });
    });

    it("is idempotent and cheap when already mirrored (state node written last)", async () => {
      const a = await seed("idem\n");
      const files = [F("x/y.txt", a)];
      const first = await mirrorWorktreeTree(blobsDir, files);
      expect(first.written).toBeGreaterThan(0);
      const second = await mirrorWorktreeTree(blobsDir, files);
      expect(second.written).toBe(0);
      expect(second.stateHash).toBe(first.stateHash);
    });

    it("shares structure: re-mirroring a small change only writes the changed spine", async () => {
      const a = await seed("one\n");
      const b = await seed("two\n");
      const base = [F("pkg/deep/a.txt", a), F("pkg/deep/b.txt", a), F("other/c.txt", a)];
      await mirrorWorktreeTree(blobsDir, base);
      // Change ONE file: only pkg/deep, pkg, root (+state) nodes are new.
      const next = [F("pkg/deep/a.txt", b), F("pkg/deep/b.txt", a), F("other/c.txt", a)];
      const mirrored = await mirrorWorktreeTree(blobsDir, next);
      expect(mirrored.written).toBe(4); // pkg/deep, pkg, root, state — `other` reused
    });

    it("expectStateHash mismatch (truncated listing) throws and writes nothing", async () => {
      const a = await seed("full\n");
      const full = [F("t/a.txt", a), F("t/b.txt", a)];
      const fullState = buildWorktreeManifest(full).stateHash;
      const truncated = [F("t/a.txt", a)];
      await expect(
        mirrorWorktreeTree(blobsDir, truncated, { expectStateHash: fullState })
      ).rejects.toThrow(/corrupt\/truncated listing/);
      // Neither the requested nor the (wrong) rebuilt state was written.
      expect(await hasTreeObject(blobsDir, fullState)).toBe(false);
      expect(await hasTreeObject(blobsDir, buildWorktreeManifest(truncated).stateHash)).toBe(false);
    });

    it("mirrors the empty listing to the canonical empty state", async () => {
      ensureLayout(blobsDir);
      const mirrored = await mirrorWorktreeTree(blobsDir, [], {
        expectStateHash: EMPTY_STATE_HASH,
      });
      expect(mirrored.stateHash).toBe(EMPTY_STATE_HASH);
      expect(await hasTreeObject(blobsDir, EMPTY_STATE_HASH)).toBe(true);
      expect(await listTree(blobsDir, EMPTY_STATE_HASH)).toEqual([]);
    });

    it("does not require file blobs to be present (server-internal writer, unlike putTree)", async () => {
      ensureLayout(blobsDir);
      const absent = "ab".repeat(32);
      const mirrored = await mirrorWorktreeTree(blobsDir, [F("ghost.txt", absent)]);
      expect(await hasTreeObject(blobsDir, mirrored.stateHash)).toBe(true);
      expect(await readFileAtTree(blobsDir, mirrored.stateHash, "ghost.txt")).toEqual({
        contentHash: absent,
        mode: 33188,
      });
    });

    it("rejects unsafe listings (traversal names, bad modes)", async () => {
      const a = await seed("bad\n");
      await expect(mirrorWorktreeTree(blobsDir, [F("../evil", a)])).rejects.toThrow(
        /Invalid tree entry name/
      );
      await expect(mirrorWorktreeTree(blobsDir, [F("ok.txt", a, 0o644)])).rejects.toThrow(
        /Invalid file mode/
      );
    });
  });

  describe("grep", () => {
    async function putViaRpc(body: string): Promise<string> {
      const service = createBlobstoreService({ blobsDir });
      await service.start?.();
      const dispatcher = createTestServiceDispatcher();
      dispatcher.registerService(service.definition);
      dispatcher.markInitialized();
      const result = (await dispatcher.dispatch(
        { caller: createVerifiedCaller("w1", "worker") },
        "blobstore",
        "putText",
        [body]
      )) as { digest: string };
      return result.digest;
    }

    function dispatchGrep(
      digest: string,
      pattern: string,
      opts?: { caseInsensitive?: boolean; contextLines?: number; maxMatches?: number }
    ): Promise<unknown> {
      const service = createBlobstoreService({ blobsDir });
      const dispatcher = createTestServiceDispatcher();
      dispatcher.registerService(service.definition);
      dispatcher.markInitialized();
      return dispatcher.dispatch(
        { caller: createVerifiedCaller("w1", "worker") },
        "blobstore",
        "grep",
        opts === undefined ? [digest, pattern] : [digest, pattern, opts]
      );
    }

    it("returns matching lines with line numbers", async () => {
      const body = ["alpha one", "beta two", "gamma three", "alpha four"].join("\n");
      const digest = await putViaRpc(body);
      const matches = (await dispatchGrep(digest, "alpha")) as Array<{
        lineNumber: number;
        line: string;
      }>;
      expect(matches.map((m) => m.lineNumber)).toEqual([1, 4]);
      expect(matches[0]!.line).toBe("alpha one");
    });

    it("honours caseInsensitive and contextLines", async () => {
      const body = ["one", "two ALPHA two", "three", "four"].join("\n");
      const digest = await putViaRpc(body);
      const matches = (await dispatchGrep(digest, "alpha", {
        caseInsensitive: true,
        contextLines: 1,
      })) as Array<{ lineNumber: number; before: string[]; after: string[] }>;
      expect(matches).toHaveLength(1);
      expect(matches[0]!.lineNumber).toBe(2);
      expect(matches[0]!.before).toEqual(["one"]);
      expect(matches[0]!.after).toEqual(["three"]);
    });

    it("caps results with maxMatches", async () => {
      const body = Array.from({ length: 20 }, (_, i) => `match line ${i}`).join("\n");
      const digest = await putViaRpc(body);
      const matches = (await dispatchGrep(digest, "match", { maxMatches: 5 })) as unknown[];
      expect(matches).toHaveLength(5);
    });

    it("returns null when the digest is unknown", async () => {
      const unknown = "0".repeat(64);
      await expect(dispatchGrep(unknown, "anything")).resolves.toBeNull();
    });

    it("rejects malformed regex patterns", async () => {
      const digest = await putViaRpc("anything");
      await expect(dispatchGrep(digest, "([")).rejects.toThrow(/Invalid regex/);
    });

    it("rejects nested-quantifier patterns (ReDoS guard)", async () => {
      // `(a+)+b` against `aaaa…c` is the classic exponential
      // backtrack — without the guard, this freezes the server.
      const digest = await putViaRpc("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa c");
      await expect(dispatchGrep(digest, "(a+)+b")).rejects.toThrow(/nested quantifiers/);
    });

    it("rejects quantified-alternation patterns (ReDoS guard)", async () => {
      const digest = await putViaRpc("aaaa");
      await expect(dispatchGrep(digest, "(a|a)*")).rejects.toThrow(/quantified alternation/);
    });

    it("rejects oversized patterns", async () => {
      const digest = await putViaRpc("hello");
      const huge = "a".repeat(2000);
      await expect(dispatchGrep(digest, huge)).rejects.toThrow(/pattern too long/);
    });
  });
});

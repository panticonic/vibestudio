import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { sha256, type BuildRecipe } from "@vibestudio/shared/execution/identity";
import { ExecutionSnapshotService } from "./executionSnapshotService.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

function recipe(target = "dev-host"): BuildRecipe {
  const digest = sha256("toolchain");
  return {
    target,
    platform: process.platform,
    architecture: process.arch,
    abi: process.versions.modules ?? null,
    options: { frozen: true },
    toolchain: { digest, components: { node: digest, pnpm: digest } },
    dependencyGraph: { digest },
    builderDigest: digest,
    declaredEnvironment: { LANG: "C.UTF-8" },
  };
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vs-execution-snapshot-"));
  roots.push(root);
  const stateHash = sha256("state");
  const blobs = new Map<string, Buffer>([
    [sha256("one"), Buffer.from("one")],
    [sha256("two"), Buffer.from("two")],
  ]);
  const files = [
    { path: "package.json", contentHash: sha256("one"), mode: 33188 },
    { path: "scripts/run.mjs", contentHash: sha256("two"), mode: 33261 },
  ];
  const service = new ExecutionSnapshotService({
    root,
    listStateFiles: async () => files,
    readBlob: async (digest) => blobs.get(digest) ?? null,
  });
  return { root, stateHash, blobs, files, service };
}

describe("ExecutionSnapshotService", () => {
  it("materializes verified immutable source and separate writable scratch", async () => {
    const f = await fixture();
    const snapshot = await f.service.create({
      source: { repoPath: "projects/vibestudio", stateHash: f.stateHash },
      recipe: recipe(),
    });
    await expect(fs.readFile(path.join(snapshot.sourceRoot, "package.json"), "utf8")).resolves.toBe(
      "one"
    );
    expect((await fs.stat(path.join(snapshot.sourceRoot, "package.json"))).mode & 0o777).toBe(
      0o444
    );
    expect((await fs.stat(path.join(snapshot.sourceRoot, "scripts/run.mjs"))).mode & 0o777).toBe(
      0o555
    );
    await fs.writeFile(path.join(snapshot.scratchRoot, "output"), "ok");
    await expect(f.service.verify(snapshot)).resolves.toBeUndefined();
    await f.service.release(snapshot);
  });

  it("captures bytes once and is unaffected by later context changes", async () => {
    const f = await fixture();
    const snapshot = await f.service.create({
      source: { repoPath: "projects/vibestudio", stateHash: f.stateHash },
      recipe: recipe(),
    });
    f.blobs.set(sha256("one"), Buffer.from("mutated live projection"));
    expect(await fs.readFile(path.join(snapshot.sourceRoot, "package.json"), "utf8")).toBe("one");
    await f.service.release(snapshot);
  });

  it("changes identity for recipe and target changes", async () => {
    const f = await fixture();
    const first = await f.service.create({
      source: { repoPath: "projects/vibestudio", stateHash: f.stateHash },
      recipe: recipe("current-host-client"),
    });
    const second = await f.service.create({
      source: { repoPath: "projects/vibestudio", stateHash: f.stateHash },
      recipe: recipe("isolated-host"),
    });
    expect(first.executionInputHash).not.toBe(second.executionInputHash);
    await f.service.release(first);
    await f.service.release(second);
  });

  it("fails before publication on missing or mismatched CAS bytes", async () => {
    const f = await fixture();
    f.blobs.delete(f.files[0]!.contentHash);
    await expect(
      f.service.create({
        source: { repoPath: "projects/vibestudio", stateHash: f.stateHash },
        recipe: recipe(),
      })
    ).rejects.toThrow("missing blob");
    expect((await fs.readdir(f.root)).flatMap((name) => name)).toEqual([]);
  });

  it("releases only roots proven to belong to the snapshot", async () => {
    const f = await fixture();
    const snapshot = await f.service.create({
      source: { repoPath: "projects/vibestudio", stateHash: f.stateHash },
      recipe: recipe(),
    });
    await f.service.release(snapshot);
    await expect(fs.access(snapshot.manifestPath)).rejects.toThrow();
    await expect(
      f.service.release({ ...snapshot, manifestPath: path.join(f.root, "foreign.json") })
    ).rejects.toThrow("outside the owned root");
  });
});

import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readThroughImmutableGitCheckout, withTemporaryGitCheckout } from "./checkout-cache.js";
import { GitClient } from "./client.js";
import {
  acquireExactGitCheckout,
  readExactGitSnapshotIndex,
  materializeExactGitSnapshot,
} from "./exact-snapshot.js";
import { sha256Hex } from "@vibestudio/content-addressing";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "git-checkout-cache-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fsp.rm(root, { recursive: true, force: true })));
});

describe("Git checkout isolation", () => {
  it("publishes coordinates before opening a lazy index at its final immutable path", async () => {
    await fsp.mkdir(path.resolve(".cache"), { recursive: true });
    const root = await fsp.mkdtemp(path.resolve(".cache/git-coordinate-publication-"));
    roots.push(root);
    const source = path.join(root, "source");
    const target = path.join(root, "exact");
    const git = new GitClient();
    await git.init(source, "main");
    await fsp.mkdir(path.join(source, "meta"));
    await fsp.writeFile(path.join(source, "meta/vibestudio.yml"), "manifest\n");
    await fsp.writeFile(path.join(source, "unit.ts"), "original\n");
    await git.add(source, ".");
    const commit = await git.commit({
      dir: source,
      message: "source",
      author: { name: "Test", email: "test@example.com" },
    });
    const clone = vi.spyOn(git, "clone").mockImplementation(async ({ dir }) => {
      await fsp.cp(source, dir, { recursive: true });
    });
    const tree = vi.spyOn(git, "readCommitTreeIndex");
    let attempt!: string;
    const coordinate = await readThroughImmutableGitCheckout({
      fs: fsp,
      target,
      label: "source",
      read: async (directory) => ({
        commit: (await git.getCurrentCommit(directory))!,
        ref: "refs/heads/main",
      }),
      prepare: async (directory) => {
        attempt = directory;
        const result = await acquireExactGitCheckout({
          git,
          dir: directory,
          url: "https://example.test/template.git",
          ref: "refs/heads/main",
          expectedCommit: commit,
          label: "template",
        });
        expect(tree).not.toHaveBeenCalled();
        return result;
      },
    });
    await expect(fsp.stat(attempt)).rejects.toMatchObject({ code: "ENOENT" });
    const index = await readExactGitSnapshotIndex({
      git,
      dir: target,
      commit: coordinate.commit,
      label: "template",
    });
    expect(tree).toHaveBeenCalledExactlyOnceWith(target, commit);
    expect(new TextDecoder().decode((await index.readFile("meta/vibestudio.yml"))!)).toBe(
      "manifest\n"
    );
    await fsp.writeFile(path.join(target, "unit.ts"), "new commit\n");
    await git.add(target, "unit.ts");
    await git.commit({
      dir: target,
      message: "move HEAD",
      author: { name: "Test", email: "test@example.com" },
    });
    const snapshot = await materializeExactGitSnapshot(index, {
      label: "template",
      sink: { put: async (bytes) => ({ digest: sha256Hex(bytes), size: bytes.byteLength }) },
    });
    expect(snapshot.commit).toBe(commit);
    expect(new TextDecoder().decode(snapshot.readFile("unit.ts")!)).toBe("original\n");
    expect(clone).toHaveBeenCalledTimes(1);
    expect(tree).toHaveBeenCalledTimes(1);
  });

  it("removes an observational checkout after returning its in-memory result", async () => {
    const root = await temporaryRoot();
    const result = await withTemporaryGitCheckout(fsp, root, "registry", async (directory) => {
      await fsp.writeFile(path.join(directory, "payload.yml"), "version: 1\n");
      return await fsp.readFile(path.join(directory, "payload.yml"), "utf8");
    });
    expect(result).toBe("version: 1\n");
    expect(await fsp.readdir(root)).toEqual([]);
  });

  it("publishes one verified immutable directory under concurrent preparation", async () => {
    const root = await temporaryRoot();
    const target = path.join(root, "exact");
    let releaseFirst!: () => void;
    const firstReady = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let prepared = 0;
    const acquire = (marker: string) =>
      readThroughImmutableGitCheckout({
        fs: fsp,
        target,
        label: "snapshot",
        read: (directory) => fsp.readFile(path.join(directory, "marker"), "utf8"),
        prepare: async (directory) => {
          prepared += 1;
          await fsp.writeFile(path.join(directory, "marker"), marker);
          if (marker === "first") await firstReady;
          return marker;
        },
      });

    const first = acquire("first");
    const second = acquire("second");
    await new Promise((resolve) => setImmediate(resolve));
    releaseFirst();
    const values = await Promise.all([first, second]);
    const published = await fsp.readFile(path.join(target, "marker"), "utf8");

    expect(prepared).toBe(2);
    expect(values.every((value) => value === published)).toBe(true);
    expect((await fsp.readdir(root)).filter((entry) => entry === "exact")).toEqual(["exact"]);
  });

  it("never deletes or repairs an invalid published exact coordinate", async () => {
    const root = await temporaryRoot();
    const target = path.join(root, "exact");
    await fsp.mkdir(target);
    await fsp.writeFile(path.join(target, "marker"), "corrupt");
    let prepared = false;

    await expect(
      readThroughImmutableGitCheckout({
        fs: fsp,
        target,
        label: "snapshot",
        read: async () => {
          throw new Error("immutable cache integrity failure");
        },
        prepare: async () => {
          prepared = true;
          return "repaired";
        },
      })
    ).rejects.toThrow("immutable cache integrity failure");
    expect(prepared).toBe(false);
    expect(await fsp.readFile(path.join(target, "marker"), "utf8")).toBe("corrupt");
  });
});

import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readThroughImmutableGitCheckout, withTemporaryGitCheckout } from "./checkout-cache.js";

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
  it("removes an observational checkout after returning its in-memory result", async () => {
    const root = await temporaryRoot();
    const result = await withTemporaryGitCheckout(fsp, root, "registry", async (directory) => {
      await fsp.writeFile(path.join(directory, "registry.yml"), "version: 1\n");
      return await fsp.readFile(path.join(directory, "registry.yml"), "utf8");
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

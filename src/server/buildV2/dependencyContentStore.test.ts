import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const cache = vi.hoisted(() => ({ root: "" }));
vi.mock("@vibestudio/env-paths", () => ({ getSharedDerivedDataPath: () => cache.root }));
import { deduplicateDependencyContent } from "./dependencyContentStore.js";
let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "dependency-content-publication-"));
  cache.root = path.join(root, "cache");
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});
it("deduplicates dependency payloads without changing their original modes", async () => {
  const first = path.join(root, "first");
  const second = path.join(root, "second");
  for (const directory of [first, second]) {
    await fs.mkdir(directory);
    await fs.writeFile(path.join(directory, "index.js"), "export default true;\n");
  }
  const originalMode = (await fs.stat(path.join(first, "index.js"))).mode & 0o7777;
  const open = vi.spyOn(fs, "open");
  await deduplicateDependencyContent(first);
  await deduplicateDependencyContent(second);
  const original = await fs.stat(path.join(first, "index.js"), { bigint: true });
  const duplicate = await fs.stat(path.join(second, "index.js"), { bigint: true });
  expect([original.dev, original.ino]).toEqual([duplicate.dev, duplicate.ino]);
  expect(Number(original.mode & 0o7777n)).toBe(originalMode);
  expect(original.nlink).toBeGreaterThanOrEqual(3n);
  expect(open).not.toHaveBeenCalled();
});

it("keeps equal payloads with distinct executable modes in distinct inode pools", async () => {
  const tree = path.join(root, "tree");
  await fs.mkdir(tree);
  const files = [path.join(tree, "data.js"), path.join(tree, "command.exe")];
  await fs.writeFile(files[0]!, "same bytes", { mode: 0o644 });
  await fs.writeFile(files[1]!, "same bytes", { mode: 0o755 });
  const modes = await Promise.all(files.map(async (file) => (await fs.stat(file)).mode & 0o7777));
  await deduplicateDependencyContent(tree);
  const stats = await Promise.all(files.map((file) => fs.stat(file)));
  expect(stats.map((stat) => stat.mode & 0o7777)).toEqual(modes);
  if (modes[0] !== modes[1]) expect(stats[0]!.ino).not.toBe(stats[1]!.ino);
});

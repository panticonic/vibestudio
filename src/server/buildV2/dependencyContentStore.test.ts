import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { closeDerivedCacheCoordinators } from "@vibestudio/shared/derivedCache";
const cache = vi.hoisted(() => ({ root: "" }));
vi.mock("@vibestudio/env-paths", () => ({ getSharedDerivedDataPath: () => cache.root }));
import {
  deduplicateDependencyContent,
  pruneUnreferencedDependencyContent,
} from "./dependencyContentStore.js";
let root: string;
beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dependency-content-publication-"));
  cache.root = path.join(root, "cache");
});
afterEach(async () => {
  vi.restoreAllMocks();
  await closeDerivedCacheCoordinators();
  await fs.promises.rm(root, { recursive: true, force: true });
});
it("deduplicates dependency payloads without changing their original modes", async () => {
  const first = path.join(root, "first");
  const second = path.join(root, "second");
  for (const directory of [first, second]) {
    await fs.promises.mkdir(directory);
    await fs.promises.writeFile(path.join(directory, "index.js"), "export default true;\n");
  }
  const originalMode = (await fs.promises.stat(path.join(first, "index.js"))).mode & 0o7777;
  const open = vi.spyOn(fs.promises, "open");
  await deduplicateDependencyContent(first);
  await deduplicateDependencyContent(second);
  const original = await fs.promises.stat(path.join(first, "index.js"), { bigint: true });
  const duplicate = await fs.promises.stat(path.join(second, "index.js"), { bigint: true });
  expect([original.dev, original.ino]).toEqual([duplicate.dev, duplicate.ino]);
  expect(Number(original.mode & 0o7777n)).toBe(originalMode);
  expect(original.nlink).toBeGreaterThanOrEqual(3n);
  expect(open).not.toHaveBeenCalled();
});

it("keeps equal payloads with distinct executable modes in distinct inode pools", async () => {
  const tree = path.join(root, "tree");
  await fs.promises.mkdir(tree);
  const files = [path.join(tree, "data.js"), path.join(tree, "command.exe")];
  await fs.promises.writeFile(files[0]!, "same bytes", { mode: 0o644 });
  await fs.promises.writeFile(files[1]!, "same bytes", { mode: 0o755 });
  const modes = await Promise.all(
    files.map(async (file) => (await fs.promises.stat(file)).mode & 0o7777)
  );
  await deduplicateDependencyContent(tree);
  const stats = await Promise.all(files.map((file) => fs.promises.stat(file)));
  expect(stats.map((stat) => stat.mode & 0o7777)).toEqual(modes);
  if (modes[0] !== modes[1]) expect(stats[0]!.ino).not.toBe(stats[1]!.ino);
});

it("starts another verified replica before the Windows hardlink ceiling", async () => {
  const tree = path.join(root, "many-dependencies");
  await fs.promises.mkdir(tree);
  const files = Array.from({ length: 1_030 }, (_, index) => path.join(tree, `package-${index}.js`));
  await Promise.all(files.map((file) => fs.promises.writeFile(file, "shared dependency payload")));

  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
  let result: Awaited<ReturnType<typeof deduplicateDependencyContent>>;
  try {
    result = await deduplicateDependencyContent(tree);
  } finally {
    Object.defineProperty(process, "platform", platformDescriptor!);
  }

  const stats = await Promise.all(files.map((file) => fs.promises.stat(file, { bigint: true })));
  const inodes = new Set(stats.map((stat) => `${stat.dev}:${stat.ino}`));
  expect(result.files).toBe(files.length);
  expect(inodes.size).toBeGreaterThan(1);
  expect(stats.every((stat) => stat.nlink <= 1_024n)).toBe(true);

  await fs.promises.rm(tree, { recursive: true, force: true });
  const pruned = await pruneUnreferencedDependencyContent();
  expect(pruned.files).toBeGreaterThanOrEqual(2);
});

it("coordinates digest capacity across independent publisher processes", async () => {
  const trees = ["publisher-a", "publisher-b"].map((name) => path.join(root, name));
  for (const tree of trees) {
    await fs.promises.mkdir(tree);
    await Promise.all(
      Array.from({ length: 520 }, (_, index) =>
        fs.promises.writeFile(path.join(tree, `package-${index}.js`), "cross-process payload")
      )
    );
  }

  const moduleUrl = new URL("./dependencyContentStore.ts", import.meta.url).href;
  const childCode = `import { deduplicateDependencyContent } from ${JSON.stringify(moduleUrl)}; await deduplicateDependencyContent(process.argv[1]);`;
  const runPublisher = (tree: string): Promise<void> =>
    new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", childCode, tree],
        {
          cwd: process.cwd(),
          env: { ...process.env, VIBESTUDIO_SHARED_DERIVED_CACHE_DIR: cache.root },
          stdio: ["ignore", "ignore", "pipe"],
        }
      );
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (code === 0) resolve();
        else reject(new Error(`Publisher exited (${code ?? signal}): ${stderr}`));
      });
    });

  await Promise.all(trees.map(runPublisher));

  const files = trees.flatMap((tree) =>
    Array.from({ length: 520 }, (_, index) => path.join(tree, `package-${index}.js`))
  );
  const stats = await Promise.all(files.map((file) => fs.promises.stat(file, { bigint: true })));
  const inodes = new Set(stats.map((stat) => `${stat.dev}:${stat.ino}`));
  if (process.platform === "win32") {
    expect(inodes.size).toBeGreaterThan(1);
    expect(stats.every((stat) => stat.nlink <= 1_024n)).toBe(true);
  }
});

it("preserves the original hardlink failure with bounded filesystem evidence", async () => {
  const tree = path.join(root, "tree");
  await fs.promises.mkdir(tree);
  const file = path.join(tree, "payload.js");
  const duplicate = path.join(tree, "duplicate.js");
  await fs.promises.writeFile(file, "immutable payload");
  await fs.promises.writeFile(duplicate, "immutable payload");
  const originalLink = fs.linkSync.bind(fs);
  const linkFailure = Object.assign(new Error("native hardlink failure"), {
    code: "UNKNOWN",
    errno: -4094,
    syscall: "link",
  });
  vi.spyOn(fs, "linkSync").mockImplementation((source, destination) => {
    if (path.basename(String(destination)).startsWith(".dependency-link-")) throw linkFailure;
    return originalLink(source, destination);
  });

  let caught: unknown;
  try {
    await deduplicateDependencyContent(tree);
  } catch (error) {
    caught = error;
  }

  expect(caught).toMatchObject({
    name: "DependencyContentLinkError",
    cause: linkFailure,
  });
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toContain("code=UNKNOWN");
  expect((caught as Error).message).toContain("errno=-4094");
  expect((caught as Error).message).toMatch(/sourceLinks=\d+/u);
  expect((caught as Error).message).toContain("sameDevice=true");
  expect((caught as Error).message).not.toContain(root);
});

it("keeps a linked replica live when pruning overlaps publication", async () => {
  const tree = path.join(root, "tree");
  await fs.promises.mkdir(tree);
  const files = [path.join(tree, "first.js"), path.join(tree, "second.js")];
  for (const file of files) await fs.promises.writeFile(file, "raced CAS payload");
  const originalLink = fs.linkSync.bind(fs);
  let prune: Promise<unknown> | undefined;
  let replacementLinks = 0;
  vi.spyOn(fs, "linkSync").mockImplementation((source, destination) => {
    if (path.basename(String(destination)).startsWith(".dependency-link-")) {
      replacementLinks += 1;
      if (replacementLinks === 1) {
        prune = pruneUnreferencedDependencyContent();
      }
    }
    return originalLink(source, destination);
  });

  const result = await deduplicateDependencyContent(tree);
  await prune;

  expect(replacementLinks).toBe(1);
  expect(result.linkedFiles).toBe(1);
  const [first, second] = await Promise.all(files.map((file) => fs.promises.stat(file)));
  expect(first!.size).toBe(second!.size);
  expect(await fs.promises.readFile(files[0]!)).toEqual(await fs.promises.readFile(files[1]!));
});

it("retains primary link and temporary-link cleanup failures", async () => {
  const tree = path.join(root, "tree");
  await fs.promises.mkdir(tree);
  const files = [path.join(tree, "first.js"), path.join(tree, "second.js")];
  for (const file of files) await fs.promises.writeFile(file, "cleanup failure payload");
  const originalLink = fs.linkSync.bind(fs);
  const primaryLinkFailure = Object.assign(new Error("primary link failure"), {
    code: "UNKNOWN",
    errno: -4094,
    syscall: "link",
  });
  const cleanupFailure = new Error("temporary link cleanup failure");
  let failedReplacement: string | undefined;
  vi.spyOn(fs, "linkSync").mockImplementation((source, destination) => {
    if (!failedReplacement && path.basename(String(destination)).startsWith(".dependency-link-")) {
      failedReplacement = String(destination);
      throw primaryLinkFailure;
    }
    return originalLink(source, destination);
  });
  const originalRm = fs.promises.rm.bind(fs.promises);
  vi.spyOn(fs.promises, "rm").mockImplementation(async (target, options) => {
    if (String(target) === failedReplacement) throw cleanupFailure;
    return originalRm(target, options);
  });

  let caught: unknown;
  try {
    await deduplicateDependencyContent(tree);
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(AggregateError);
  expect((caught as AggregateError).errors).toEqual([
    expect.objectContaining({
      name: "DependencyContentLinkError",
      cause: primaryLinkFailure,
    }),
    cleanupFailure,
  ]);
  expect((caught as Error & { cause?: unknown }).cause).toBe((caught as AggregateError).errors[0]);
});

it("joins all hash workers and aggregates independent failures", async () => {
  const tree = path.join(root, "tree");
  await fs.promises.mkdir(tree);
  const files = [
    "failure-a.js",
    "failure-b.js",
    "wait-a.js",
    "wait-b.js",
    "wait-c.js",
    "wait-d.js",
    "wait-e.js",
    "wait-f.js",
  ].map((name) => path.join(tree, name));
  for (const [index, file] of files.entries()) {
    await fs.promises.writeFile(file, `unique payload ${index}`);
  }
  const failures = [new Error("failure A"), new Error("failure B")];
  let rejectFailuresObserved!: () => void;
  const failuresObserved = new Promise<void>((resolve) => {
    rejectFailuresObserved = resolve;
  });
  let resolveSuccessWorkers!: () => void;
  const releaseWorkers = new Promise<void>((resolve) => {
    resolveSuccessWorkers = resolve;
  });
  let resolveWaitStarted!: () => void;
  const waitStarted = new Promise<void>((resolve) => {
    resolveWaitStarted = resolve;
  });
  let failureCount = 0;
  let successfulWorkerStarted = false;
  let resolveSuccessfulWorkerStarted!: () => void;
  const successStarted = new Promise<void>((resolve) => {
    resolveSuccessfulWorkerStarted = resolve;
  });
  const originalLink = fs.linkSync.bind(fs);
  vi.spyOn(fs, "linkSync").mockImplementation((source, destination) => {
    const sourceName = path.basename(String(source));
    if (sourceName === "failure-a.js" || sourceName === "failure-b.js") {
      failureCount += 1;
      if (failureCount === failures.length) rejectFailuresObserved();
      throw failures[sourceName === "failure-a.js" ? 0 : 1];
    }
    successfulWorkerStarted = true;
    resolveSuccessfulWorkerStarted();
    return originalLink(source, destination);
  });
  const originalLstat = fs.promises.lstat.bind(fs.promises);
  vi.spyOn(fs.promises, "lstat").mockImplementation(async (target, options) => {
    if (path.basename(String(target)) === "wait-a.js") {
      resolveWaitStarted();
      await releaseWorkers;
    }
    return originalLstat(target, options);
  });

  let settled = false;
  const pending = deduplicateDependencyContent(tree);
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  await Promise.all([failuresObserved, successStarted, waitStarted]);
  expect(successfulWorkerStarted).toBe(true);
  expect(settled).toBe(false);
  resolveSuccessWorkers();

  let caught: unknown;
  try {
    await pending;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(AggregateError);
  expect((caught as AggregateError).errors).toEqual(failures);
  expect((caught as Error & { cause?: unknown }).cause).toBe(failures[0]);
});

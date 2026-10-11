import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  closeDerivedCacheCoordinators,
  derivedCacheCoordinator,
  derivedCacheDatabasePath,
} from "@vibestudio/shared/derivedCache";
const cache = vi.hoisted(() => ({ root: "" }));
vi.mock("@vibestudio/env-paths", () => ({ getSharedDerivedDataPath: () => cache.root }));
import {
  deduplicateDependencyContent,
  pruneUnreferencedDependencyContent,
} from "./dependencyContentStore.js";
let root: string;
const publisherChildren = new Set<{
  child: ChildProcess;
  closed: Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>;
}>();
beforeEach(async () => {
  root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dependency-content-publication-"));
  cache.root = path.join(root, "cache");
});
afterEach(async () => {
  vi.restoreAllMocks();
  const cleanupErrors: unknown[] = [];
  const children = [...publisherChildren];
  for (const { child } of children) {
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
  }
  const childResults = await Promise.allSettled(children.map(({ closed }) => closed));
  for (const result of childResults) {
    if (result.status === "rejected") cleanupErrors.push(result.reason);
  }
  publisherChildren.clear();
  try {
    await closeDerivedCacheCoordinators();
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    await fs.promises.rm(root, { recursive: true, force: true });
  } catch (error) {
    cleanupErrors.push(error);
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "Failed to retire dependency publisher children");
  }
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
  const seedTree = path.join(root, "seed");
  await fs.promises.mkdir(seedTree);
  const seedFile = path.join(seedTree, "package.js");
  await fs.promises.writeFile(seedFile, "shared dependency payload");
  await deduplicateDependencyContent(seedTree);

  // Start the primary replica at the boundary instead of hashing a thousand
  // identical files merely to reach it. The source file and CAS entry share
  // one link; these anchors bring that verified inode to 1,023 links.
  const anchorDirectory = path.join(root, "anchors");
  await fs.promises.mkdir(anchorDirectory);
  for (let index = 0; index < 1_021; index += 1) {
    await fs.promises.link(seedFile, path.join(anchorDirectory, `anchor-${index}`));
  }
  expect((await fs.promises.stat(seedFile, { bigint: true })).nlink).toBe(1_023n);

  const tree = path.join(root, "many-dependencies");
  await fs.promises.mkdir(tree);
  const files = Array.from({ length: 3 }, (_, index) => path.join(tree, `package-${index}.js`));
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
  await fs.promises.rm(anchorDirectory, { recursive: true, force: true });
  await fs.promises.rm(seedTree, { recursive: true, force: true });
  const pruned = await pruneUnreferencedDependencyContent();
  expect(pruned.files).toBeGreaterThanOrEqual(2);
});

it("coordinates digest capacity across independent publisher processes", async () => {
  const seedTree = path.join(root, "seed");
  await fs.promises.mkdir(seedTree);
  const seedFile = path.join(seedTree, "package.js");
  await fs.promises.writeFile(seedFile, "cross-process payload");
  await deduplicateDependencyContent(seedTree);

  const anchorDirectory = path.join(root, "anchors");
  await fs.promises.mkdir(anchorDirectory);
  for (let index = 0; index < 1_021; index += 1) {
    await fs.promises.link(seedFile, path.join(anchorDirectory, `anchor-${index}`));
  }
  const anchoredStat = await fs.promises.stat(seedFile, { bigint: true });
  expect(anchoredStat.nlink).toBe(1_023n);
  await closeDerivedCacheCoordinators();

  const trees = ["publisher-a", "publisher-b"].map((name) => path.join(root, name));
  for (const tree of trees) {
    await fs.promises.mkdir(tree);
    await fs.promises.writeFile(path.join(tree, "package.js"), "cross-process payload");
  }

  const moduleUrl = new URL("./dependencyContentStore.ts", import.meta.url).href;
  const childCode = `
    import { deduplicateDependencyContent } from ${JSON.stringify(moduleUrl)};
    import { closeDerivedCacheCoordinators } from "@vibestudio/shared/derivedCache";
    const failures = [];
    process.send({ type: "publisher-ready" });
    try {
      await new Promise((resolve, reject) => {
        process.once("message", (message) => {
          if (message?.type === "publish") resolve();
          else reject(new Error("Publisher received an invalid release message"));
        });
      });
      await deduplicateDependencyContent(process.argv[1]);
    }
    catch (error) { failures.push(error); }
    try { await closeDerivedCacheCoordinators(); }
    catch (error) { failures.push(error); }
    process.disconnect();
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, "Publisher operation and cleanup failed", { cause: failures[0] });
    }
  `;
  const publishers = trees.map((tree) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "-e", childCode, tree],
      {
        cwd: process.cwd(),
        env: { ...process.env, VIBESTUDIO_SHARED_DERIVED_CACHE_DIR: cache.root },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      }
    );
    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    let spawnError: Error | undefined;
    child.once("error", (error) => {
      spawnError = error;
    });
    const closed = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
      stderr: string;
      spawnError: Error | undefined;
    }>((resolve) => {
      child.once("close", (code, signal) => resolve({ code, signal, stderr, spawnError }));
    });
    const ready = new Promise<void>((resolve, reject) => {
      child.once("message", (message: unknown) => {
        if (
          message &&
          typeof message === "object" &&
          (message as { type?: unknown }).type === "publisher-ready"
        ) {
          resolve();
        } else {
          reject(new Error("Publisher sent an invalid readiness message"));
        }
      });
      child.once("error", reject);
      child.once("close", (code, signal) => {
        reject(new Error(`Publisher closed before readiness (${code ?? signal}): ${stderr}`));
      });
    });
    const owned = { child, closed };
    publisherChildren.add(owned);
    return { child, ready, closed };
  });

  const readinessResults = await Promise.allSettled(
    publishers.map(({ child, ready }) =>
      ready.catch((error: unknown) => {
        for (const sibling of publishers) {
          if (
            sibling.child !== child &&
            sibling.child.exitCode === null &&
            sibling.child.signalCode === null
          ) {
            sibling.child.kill();
          }
        }
        throw error;
      })
    )
  );
  const readinessFailures = readinessResults.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : []
  );
  if (readinessFailures.length > 0) {
    for (const { child } of publishers) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
    const closedResults = await Promise.allSettled(publishers.map(({ closed }) => closed));
    const closeFailures = closedResults.flatMap((result) => {
      if (result.status === "rejected") return [result.reason];
      const { code, signal, spawnError, stderr } = result.value;
      if (spawnError !== undefined) return [spawnError];
      if (code !== 0 || signal !== null)
        return [new Error(`Publisher closed during readiness (${code ?? signal}): ${stderr}`)];
      return [];
    });
    const failures = [...readinessFailures, ...closeFailures];
    if (failures.length === 1) throw failures[0];
    throw new AggregateError(failures, "Publisher readiness and retirement failed", {
      cause: failures[0],
    });
  }

  const releaseResults = await Promise.allSettled(
    publishers.map(
      ({ child }) =>
        new Promise<void>((resolve, reject) => {
          let settled = false;
          const fail = (error: unknown) => {
            if (settled) return;
            settled = true;
            reject(error);
          };
          child.once("close", (code, signal) => {
            fail(new Error(`Publisher closed before release confirmation (${code ?? signal})`));
          });
          child.send({ type: "publish" }, (error) => {
            if (error !== null && error !== undefined) {
              fail(error);
              return;
            }
            if (settled) return;
            settled = true;
            resolve();
          });
        })
    )
  );
  const releaseFailures = releaseResults.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : []
  );
  if (releaseFailures.length > 0) {
    for (const { child } of publishers) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
  }

  const processResults = await Promise.allSettled(
    publishers.map(({ closed }) =>
      closed.then(({ code, signal, stderr: childStderr, spawnError }) => {
        if (spawnError !== undefined) throw spawnError;
        if (code !== 0) {
          throw new Error(`Publisher exited (${code ?? signal}): ${childStderr}`);
        }
      })
    )
  );
  const publisherResults = [...releaseResults, ...processResults];
  const publisherFailures = publisherResults.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : []
  );
  if (publisherFailures.length > 0) {
    if (publisherFailures.length === 1) throw publisherFailures[0];
    throw new AggregateError(publisherFailures, "Dependency publisher process failed", {
      cause: publisherFailures[0],
    });
  }

  const files = trees.map((tree) => path.join(tree, "package.js"));
  const stats = await Promise.all(files.map((file) => fs.promises.stat(file, { bigint: true })));
  const inodes = new Set(stats.map((stat) => `${stat.dev}:${stat.ino}`));
  if (process.platform === "win32") {
    expect(inodes.size).toBeGreaterThan(1);
    expect(stats.every((stat) => stat.nlink <= 1_024n)).toBe(true);
  } else {
    expect(inodes.size).toBe(1);
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

  expect(caught).toBeInstanceOf(Error);
  const coordinatorFailure = caught as Error & { cause?: unknown };
  expect(coordinatorFailure).toMatchObject({
    name: "DependencyContentCoordinatorError",
    message: "Dependency content coordinator selecting a reusable replica failed",
  });
  const linkError = coordinatorFailure.cause as Error & { cause?: unknown };
  expect(linkError).toMatchObject({
    name: "DependencyContentLinkError",
    cause: linkFailure,
  });
  expect(linkError.message).toContain("code=UNKNOWN");
  expect(linkError.message).toContain("errno=-4094");
  expect(linkError.message).toMatch(/sourceLinks=\d+/u);
  expect(linkError.message).toContain("sameDevice=true");
  expect(linkError.message).not.toContain(root);
});

it("retains SQLite transaction diagnostics across parallel deduplication workers", async () => {
  const tree = path.join(root, "locked-tree");
  await fs.promises.mkdir(tree);
  for (const name of ["first.js", "second.js"])
    await fs.promises.writeFile(path.join(tree, name), `payload ${name}`);

  const coordinatorRoot = path.join(cache.root, "dependency-files");
  const coordinator = derivedCacheCoordinator(coordinatorRoot);
  // Keep the real busy-handler and transaction path, with a short test-only wait.
  (coordinator as unknown as { db: DatabaseSync }).db.exec("PRAGMA busy_timeout = 25");
  const blocker = new DatabaseSync(derivedCacheDatabasePath(coordinatorRoot));
  blocker.exec("BEGIN IMMEDIATE");
  let caught: unknown;
  try {
    await deduplicateDependencyContent(tree);
  } catch (error) {
    caught = error;
  } finally {
    blocker.exec("ROLLBACK");
    blocker.close();
  }

  expect(caught).toBeInstanceOf(AggregateError);
  const errors = (caught as AggregateError).errors as Array<Error & { cause?: unknown }>;
  expect(errors).toHaveLength(2);
  for (const error of errors) {
    expect(error).toMatchObject({
      name: "DependencyContentCoordinatorError",
      code: "ERR_SQLITE_ERROR",
      cause: {
        code: "ERR_SQLITE_ERROR",
        errcode: 5,
        errstr: "database is locked",
      },
    });
    expect(error.message).toContain("acquiring a digest lease");
  }
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
  const errors = (caught as AggregateError).errors as Array<Error & { cause?: unknown }>;
  expect(errors).toHaveLength(2);
  expect(errors[0]).toMatchObject({
    name: "DependencyContentCoordinatorError",
    message: "Dependency content coordinator selecting a reusable replica failed",
  });
  expect(errors[0]!.cause).toMatchObject({
    name: "DependencyContentLinkError",
    cause: primaryLinkFailure,
  });
  expect(errors[1]).toBe(cleanupFailure);
  expect((caught as Error & { cause?: unknown }).cause).toBe(errors[0]);
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
  const workerErrors = (caught as AggregateError).errors as Array<Error & { cause?: unknown }>;
  expect(workerErrors).toHaveLength(failures.length);
  expect(workerErrors.map((error) => error.cause)).toEqual(failures);
  for (const [index, error] of workerErrors.entries()) {
    expect(error.cause).toBe(failures[index]);
    expect(error).toMatchObject({
      name: "DependencyContentCoordinatorError",
      message: "Dependency content coordinator publishing the primary replica failed",
    });
  }
  expect((caught as Error & { cause?: unknown }).cause).toBe(workerErrors[0]);
});

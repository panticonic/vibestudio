import * as crypto from "node:crypto";
import fs from "node:fs";
import * as path from "node:path";
import { getSharedDerivedDataPath } from "@vibestudio/env-paths";
import { derivedCacheCoordinator } from "@vibestudio/shared/derivedCache";
import { blobCasPath } from "../storage/blobCas.js";

const HASH_CONCURRENCY = 8;
const VERIFIED_CONTENT_LIMIT = 100_000;
const WINDOWS_MAX_CONTENT_HARDLINKS = 1024;
let contentPrune: Promise<DependencyContentPrune> | null = null;
const verifiedContent = new Map<
  string,
  { dev: number; ino: number; size: number; mtimeMs: number; mode: number }
>();

export interface DependencyContentDeduplication {
  files: number;
  bytes: number;
  linkedFiles: number;
  linkedBytes: number;
}

export interface DependencyContentPrune {
  files: number;
  bytes: number;
}

function contentStoreRoot(mode: number): string {
  return path.join(
    getSharedDerivedDataPath(),
    "dependency-files",
    (mode & 0o7777).toString(8).padStart(4, "0")
  );
}

function contentCoordinatorRoot(): string {
  return path.join(getSharedDerivedDataPath(), "dependency-files");
}

function contentLeaseKey(mode: number, digest: string): string {
  return `${(mode & 0o7777).toString(8).padStart(4, "0")}-${digest}`;
}

function contentHardlinkLimit(platform = process.platform): number {
  // NTFS permits at most 1,024 names for one file. Keep other platforms on
  // their existing behavior rather than imposing NTFS's lower limit there.
  return platform === "win32" ? WINDOWS_MAX_CONTENT_HARDLINKS : Number.MAX_SAFE_INTEGER;
}

function contentReplicaPath(storeRoot: string, digest: string, replica: number): string {
  if (replica === 0) return blobCasPath(storeRoot, digest);
  return path.join(storeRoot, "replicas", digest, String(replica));
}

function contentReplicaPaths(storeRoot: string, digest: string): string[] {
  const paths = [contentReplicaPath(storeRoot, digest, 0)];
  const replicasDirectory = path.join(storeRoot, "replicas", digest);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(replicasDirectory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return paths;
    throw error;
  }
  const replicas = entries
    .filter((entry) => entry.isFile() && /^(0|[1-9][0-9]*)$/u.test(entry.name))
    .map((entry) => Number(entry.name))
    .filter((replica) => Number.isSafeInteger(replica) && replica > 0)
    .sort((left, right) => left - right);
  for (const replica of replicas) paths.push(contentReplicaPath(storeRoot, digest, replica));
  return paths;
}

async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  const stream = fs.createReadStream(filePath);
  for await (const chunk of stream) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

async function regularFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
      const storedPath = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(storedPath);
      else if (entry.isFile()) files.push(storedPath);
    }
  }
  return files;
}

function sameInode(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function linkWithDiagnosticsSync(sourcePath: string, destinationPath: string): void {
  try {
    fs.linkSync(sourcePath, destinationPath);
  } catch (cause) {
    const source = (() => {
      try {
        return fs.lstatSync(sourcePath);
      } catch {
        return null;
      }
    })();
    const destinationDirectory = (() => {
      try {
        return fs.lstatSync(path.dirname(destinationPath));
      } catch {
        return null;
      }
    })();
    const errorDetails = cause as NodeJS.ErrnoException;
    const sameDevice =
      source && destinationDirectory ? source.dev === destinationDirectory.dev : undefined;
    const details = [
      `code=${errorDetails.code ?? "unknown"}`,
      `errno=${typeof errorDetails.errno === "number" ? errorDetails.errno : "unknown"}`,
      `syscall=${errorDetails.syscall ?? "link"}`,
      `sourceLinks=${source?.nlink ?? "unavailable"}`,
      `sameDevice=${sameDevice ?? "unavailable"}`,
    ].join(" ");
    const failure = new Error(`Dependency content hardlink failed (${details})`, {
      cause,
    }) as NodeJS.ErrnoException;
    failure.name = "DependencyContentLinkError";
    if (errorDetails.code !== undefined) failure.code = errorDetails.code;
    if (errorDetails.errno !== undefined) failure.errno = errorDetails.errno;
    if (errorDetails.syscall !== undefined) failure.syscall = errorDetails.syscall;
    throw failure;
  }
}

function rememberVerifiedContent(storedPath: string, stat: fs.Stats): void {
  if (verifiedContent.size >= VERIFIED_CONTENT_LIMIT) {
    verifiedContent.delete(verifiedContent.keys().next().value!);
  }
  verifiedContent.set(storedPath, {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    mode: stat.mode & 0o7777,
  });
}

function verifiedContentMatches(storedPath: string, stat: fs.Stats): boolean {
  const verified = verifiedContent.get(storedPath);
  return Boolean(
    verified &&
    stat.dev === verified.dev &&
    stat.ino === verified.ino &&
    stat.size === verified.size &&
    stat.mtimeMs === verified.mtimeMs &&
    (stat.mode & 0o7777) === verified.mode
  );
}

async function verifyContentReplica(
  storedPath: string,
  digest: string,
  expectedSize: number,
  expectedMode: number
): Promise<fs.Stats | null> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.lstat(storedPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (
    !stat.isFile() ||
    stat.size !== expectedSize ||
    (stat.mode & 0o7777) !== (expectedMode & 0o7777)
  ) {
    throw new Error(`Dependency content integrity mismatch at ${storedPath}`);
  }
  if (!verifiedContentMatches(storedPath, stat)) {
    if ((await sha256File(storedPath)) !== digest) {
      throw new Error(`Dependency content integrity mismatch at ${storedPath}`);
    }
    const confirmed = await fs.promises.lstat(storedPath);
    if (
      confirmed.dev !== stat.dev ||
      confirmed.ino !== stat.ino ||
      confirmed.size !== stat.size ||
      confirmed.mtimeMs !== stat.mtimeMs ||
      (confirmed.mode & 0o7777) !== (stat.mode & 0o7777)
    ) {
      throw new Error(`Dependency content changed while verifying ${storedPath}`);
    }
    stat = confirmed;
    rememberVerifiedContent(storedPath, stat);
  }
  return stat;
}

async function stageVerifiedReplica(
  storeRoot: string,
  digest: string,
  sourcePath: string,
  expectedSize: number,
  mode: number
): Promise<string> {
  const stagingRoot = path.join(storeRoot, ".staging");
  await fs.promises.mkdir(stagingRoot, { recursive: true, mode: 0o700 });
  const stagedPath = path.join(
    stagingRoot,
    `${digest}-${process.pid}-${crypto.randomBytes(8).toString("hex")}`
  );
  try {
    await fs.promises.copyFile(sourcePath, stagedPath, fs.constants.COPYFILE_EXCL);
    await fs.promises.chmod(stagedPath, mode & 0o7777);
    const stat = await fs.promises.lstat(stagedPath);
    if (!stat.isFile() || stat.size !== expectedSize || (await sha256File(stagedPath)) !== digest) {
      throw new Error("Dependency content replica failed digest verification");
    }
    return stagedPath;
  } catch (error) {
    try {
      await fs.promises.rm(stagedPath, { force: true });
    } catch (cleanupFailure) {
      throw new AggregateError(
        [error, cleanupFailure],
        "Dependency replica staging and cleanup failed",
        { cause: error }
      );
    }
    throw error;
  }
}

function nextContentReplica(storeRoot: string, digest: string): number {
  const paths = contentReplicaPaths(storeRoot, digest);
  let next = 1;
  for (const candidate of paths.slice(1)) {
    const replica = Number(path.basename(candidate));
    if (replica >= next) next = replica + 1;
  }
  return next;
}

function linkAvailableReplica(
  coordinatorRoot: string,
  storeRoot: string,
  digest: string,
  replacement: string
): string | null {
  const coordinator = derivedCacheCoordinator(coordinatorRoot);
  let selected: string | null = null;
  coordinator.withMutation(() => {
    for (const candidate of contentReplicaPaths(storeRoot, digest)) {
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(candidate);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (!verifiedContentMatches(candidate, stat) || stat.nlink >= contentHardlinkLimit())
        continue;
      linkWithDiagnosticsSync(candidate, replacement);
      selected = candidate;
      return;
    }
  });
  return selected;
}

async function ensurePrimaryReplica(
  storeRoot: string,
  digest: string,
  sourcePath: string,
  expectedSize: number,
  mode: number,
  coordinatorRoot: string
): Promise<void> {
  const target = blobCasPath(storeRoot, digest);
  const existing = await verifyContentReplica(target, digest, expectedSize, mode);
  if (existing) return;
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const coordinator = derivedCacheCoordinator(coordinatorRoot);
  let requiresCopy = false;
  coordinator.withMutation(() => {
    if (fs.existsSync(target)) return;
    const sourceStat = fs.lstatSync(sourcePath);
    if (sourceStat.nlink >= contentHardlinkLimit()) {
      requiresCopy = true;
      return;
    }
    try {
      fs.linkSync(sourcePath, target);
      rememberVerifiedContent(target, fs.lstatSync(target));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EXDEV") {
        requiresCopy = true;
        return;
      }
      throw error;
    }
  });
  if (fs.existsSync(target)) {
    const stat = await verifyContentReplica(target, digest, expectedSize, mode);
    if (!stat) throw new Error("Dependency content replica disappeared after publication");
    return;
  }
  if (!requiresCopy) return;

  const staged = await stageVerifiedReplica(storeRoot, digest, sourcePath, expectedSize, mode);
  let primaryFailure: unknown;
  let hasPrimaryFailure = false;
  try {
    coordinator.withMutation(() => {
      if (fs.existsSync(target)) return;
      fs.renameSync(staged, target);
      rememberVerifiedContent(target, fs.lstatSync(target));
    });
  } catch (error) {
    primaryFailure = error;
    hasPrimaryFailure = true;
  }
  let cleanupFailure: unknown;
  let hasCleanupFailure = false;
  try {
    await fs.promises.rm(staged, { force: true });
  } catch (error) {
    cleanupFailure = error;
    hasCleanupFailure = true;
  }
  if (hasPrimaryFailure && hasCleanupFailure) {
    throw new AggregateError(
      [primaryFailure, cleanupFailure],
      "Dependency replica publication and staging cleanup failed",
      { cause: primaryFailure }
    );
  }
  if (hasPrimaryFailure) throw primaryFailure;
  if (hasCleanupFailure) throw cleanupFailure;
}

async function replaceWithContentLink(
  filePath: string
): Promise<{ bytes: number; linked: boolean }> {
  const sourceStat = await fs.promises.lstat(filePath);
  const digest = await sha256File(filePath);
  const storeRoot = contentStoreRoot(sourceStat.mode);
  const coordinatorRoot = contentCoordinatorRoot();
  const coordinator = derivedCacheCoordinator(coordinatorRoot);
  const lease = coordinator.acquire(coordinatorRoot, contentLeaseKey(sourceStat.mode, digest));

  const replacement = path.join(
    path.dirname(filePath),
    `.dependency-link-${process.pid}-${crypto.randomBytes(8).toString("hex")}`
  );
  let primaryFailure: unknown;
  let hasPrimaryFailure = false;
  let staged: string | undefined;
  let alreadyCanonical = false;
  try {
    await ensurePrimaryReplica(
      storeRoot,
      digest,
      filePath,
      sourceStat.size,
      sourceStat.mode,
      coordinatorRoot
    );
    for (const candidate of contentReplicaPaths(storeRoot, digest)) {
      const stat = await verifyContentReplica(candidate, digest, sourceStat.size, sourceStat.mode);
      if (stat && sameInode(sourceStat, stat)) alreadyCanonical = true;
    }
    if (
      !alreadyCanonical &&
      !linkAvailableReplica(coordinatorRoot, storeRoot, digest, replacement)
    ) {
      staged = await stageVerifiedReplica(
        storeRoot,
        digest,
        filePath,
        sourceStat.size,
        sourceStat.mode
      );
      coordinator.withMutation(() => {
        // Another process may have opened a replica while this copy was being
        // verified. Only use replicas this process has already verified.
        for (const candidate of contentReplicaPaths(storeRoot, digest)) {
          let stat: fs.Stats;
          try {
            stat = fs.lstatSync(candidate);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
            throw error;
          }
          if (!verifiedContentMatches(candidate, stat) || stat.nlink >= contentHardlinkLimit())
            continue;
          linkWithDiagnosticsSync(candidate, replacement);
          return;
        }
        const replica = nextContentReplica(storeRoot, digest);
        const target = contentReplicaPath(storeRoot, digest, replica);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.renameSync(staged!, target);
        const stat = fs.lstatSync(target);
        rememberVerifiedContent(target, stat);
        linkWithDiagnosticsSync(target, replacement);
      });
    }
    if (!alreadyCanonical) await fs.promises.rename(replacement, filePath);
  } catch (error) {
    hasPrimaryFailure = true;
    primaryFailure = error;
  }
  const cleanupFailures: unknown[] = [];
  try {
    await fs.promises.rm(replacement, { force: true });
  } catch (cleanupFailure) {
    cleanupFailures.push(cleanupFailure);
  }
  if (staged) {
    try {
      await fs.promises.rm(staged, { force: true });
    } catch (cleanupFailure) {
      cleanupFailures.push(cleanupFailure);
    }
  }
  try {
    lease.release();
  } catch (releaseFailure) {
    cleanupFailures.push(releaseFailure);
  }
  if (hasPrimaryFailure && cleanupFailures.length > 0) {
    throw new AggregateError(
      [primaryFailure, ...cleanupFailures],
      "Dependency content publication and cleanup failed",
      { cause: primaryFailure }
    );
  }
  if (hasPrimaryFailure) throw primaryFailure;
  if (cleanupFailures.length === 1) throw cleanupFailures[0];
  if (cleanupFailures.length > 1) {
    throw new AggregateError(cleanupFailures, "Dependency content cleanup failed", {
      cause: cleanupFailures[0],
    });
  }
  return { bytes: sourceStat.size, linked: !alreadyCanonical };
}

/**
 * Replace immutable dependency payloads with hardlinks into a profile-wide
 * mode-and-digest store. When a digest reaches NTFS's link ceiling, verified
 * physical replicas share the same content address. The dependency directory
 * must still be unpublished: callers may read it only after this operation
 * and the subsequent atomic promotion.
 *
 * Trusted installers finish mutations before publishing the cache. Workspace
 * consumers receive read-only MXC resource grants; file attributes do not carry
 * that authority. Preserve original modes in the store namespace so sharing
 * cannot change executable or permission bits. A cross-process coordinator
 * serializes replica allocation against final pruning. Symlinks are topology, not
 * payload, and deliberately remain in the closure.
 */
export async function deduplicateDependencyContent(
  unpublishedCacheDir: string
): Promise<DependencyContentDeduplication> {
  const files = await regularFiles(unpublishedCacheDir);
  let cursor = 0;
  const result: DependencyContentDeduplication = {
    files: 0,
    bytes: 0,
    linkedFiles: 0,
    linkedBytes: 0,
  };

  const workers = Array.from({ length: Math.min(HASH_CONCURRENCY, files.length) }, async () => {
    for (;;) {
      const filePath = files[cursor++];
      if (!filePath) return;
      const linked = await replaceWithContentLink(filePath);
      result.files += 1;
      result.bytes += linked.bytes;
      if (linked.linked) {
        result.linkedFiles += 1;
        result.linkedBytes += linked.bytes;
      }
    }
  });
  const outcomes = await Promise.allSettled(workers);
  const failures = outcomes.flatMap((outcome) =>
    outcome.status === "rejected" ? [outcome.reason] : []
  );
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "Dependency content deduplication workers failed", {
      cause: failures[0],
    });
  }
  return result;
}

function digestFromStoredPath(storeRoot: string, storedPath: string): string | null {
  const relative = path.relative(storeRoot, storedPath).split(path.sep);
  if (
    relative.length === 4 &&
    relative[0] === "sha256" &&
    /^[a-f0-9]{2}$/u.test(relative[1]!) &&
    /^[a-f0-9]{2}$/u.test(relative[2]!)
  ) {
    const digest = `${relative[1]}${relative[2]}${relative[3]}`;
    return /^[a-f0-9]{64}$/u.test(digest) ? digest : null;
  }
  if (
    relative.length === 3 &&
    relative[0] === "replicas" &&
    /^[a-f0-9]{64}$/u.test(relative[1]!) &&
    /^(0|[1-9][0-9]*)$/u.test(relative[2]!)
  ) {
    return relative[1]!;
  }
  if (
    relative.length === 2 &&
    relative[0] === ".staging" &&
    /^[a-f0-9]{64}-[0-9]+-[a-f0-9]+$/u.test(relative[1]!)
  ) {
    return relative[1]!.slice(0, 64);
  }
  return null;
}

async function pruneContentFiles(storeRoot: string): Promise<DependencyContentPrune> {
  const coordinatorRoot = contentCoordinatorRoot();
  const coordinator = derivedCacheCoordinator(coordinatorRoot);
  const result = { files: 0, bytes: 0 };
  const mode = Number.parseInt(path.basename(storeRoot), 8);
  for (const storedPath of await regularFiles(storeRoot)) {
    const digest = digestFromStoredPath(storeRoot, storedPath);
    if (!digest) continue;
    const removal = coordinator.withMutation(() => {
      if (coordinator.hasLease(coordinatorRoot, contentLeaseKey(mode, digest))) return null;
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(storedPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
      if (!stat.isFile() || stat.nlink !== 1) return null;
      fs.unlinkSync(storedPath);
      return { bytes: (stat.blocks ?? 0) * 512 || stat.size };
    });
    if (removal) {
      result.files += 1;
      result.bytes += removal.bytes;
    }
  }
  return result;
}

/** Remove content objects that no published dependency environment references. */
export function pruneUnreferencedDependencyContent(): Promise<DependencyContentPrune> {
  if (contentPrune) return contentPrune;
  contentPrune = (async () => {
    const root = path.join(getSharedDerivedDataPath(), "dependency-files");
    let modes: fs.Dirent[];
    try {
      modes = await fs.promises.readdir(root, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { files: 0, bytes: 0 };
      throw error;
    }
    const total = { files: 0, bytes: 0 };
    for (const mode of modes) {
      if (!mode.isDirectory() || !/^[0-7]{4}$/u.test(mode.name)) continue;
      const pruned = await pruneContentFiles(path.join(root, mode.name));
      total.files += pruned.files;
      total.bytes += pruned.bytes;
    }
    return total;
  })().finally(() => {
    contentPrune = null;
  });
  return contentPrune;
}

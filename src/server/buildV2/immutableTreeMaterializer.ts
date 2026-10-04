import * as fs from "node:fs";
import * as path from "node:path";

const FILE_CONCURRENCY = 32;

interface ProjectionEntry {
  source: string;
  target: string;
  kind: "file" | "symlink";
}

async function mapConcurrent<T>(
  values: readonly T[],
  concurrency: number,
  apply: (value: T) => Promise<void>
): Promise<void> {
  let cursor = 0;
  const failures: unknown[] = [];
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (failures.length === 0) {
        const value = values[cursor++];
        if (value === undefined) return;
        try {
          await apply(value);
        } catch (error) {
          failures.push(error);
          return;
        }
      }
    })
  );
  // Error publication transfers ownership back to the caller, which may
  // immediately delete the target or release the source installation. Join
  // every admitted copy before that boundary, even after one copy fails.
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(failures, "Immutable dependency projection failed", {
      cause: failures[0],
    });
}

/**
 * Hardlink one immutable dependency environment into a durable build.
 *
 * Directory discovery and the high-volume lstat/link/copy callbacks run in a
 * worker thread. The workspace server only awaits one completion message, so
 * dependency projection cannot monopolize its control-plane event loop.
 */
export async function materializeImmutableTree(source: string, target: string): Promise<void> {
  if (process.platform === "win32") return materializePrivateTree(source, target);
  const sourceRoot = path.resolve(source);
  const targetRoot = path.resolve(target);
  const pendingDirectories = [{ source: sourceRoot, target: targetRoot }];
  const entries: ProjectionEntry[] = [];

  while (pendingDirectories.length > 0) {
    const directory = pendingDirectories.pop()!;
    const stat = await fs.promises.lstat(directory.source);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Immutable tree root is not a directory: ${directory.source}`);
    }
    await fs.promises.mkdir(directory.target, { recursive: true, mode: stat.mode });
    for (const child of await fs.promises.readdir(directory.source, { withFileTypes: true })) {
      const childSource = path.join(directory.source, child.name);
      const childTarget = path.join(directory.target, child.name);
      if (child.isDirectory()) {
        pendingDirectories.push({ source: childSource, target: childTarget });
      } else if (child.isFile()) {
        entries.push({ source: childSource, target: childTarget, kind: "file" });
      } else if (child.isSymbolicLink()) {
        entries.push({ source: childSource, target: childTarget, kind: "symlink" });
      } else {
        throw new Error(`Unsupported runtime dependency entry: ${childSource}`);
      }
    }
  }

  await mapConcurrent(entries, FILE_CONCURRENCY, async (entry) => {
    await fs.promises.mkdir(path.dirname(entry.target), { recursive: true });
    if (entry.kind === "symlink") {
      await fs.promises.symlink(await fs.promises.readlink(entry.source), entry.target);
      return;
    }
    try {
      await fs.promises.link(entry.source, entry.target);
    } catch (error) {
      if (
        !["EXDEV", "EPERM", "EACCES", "EMLINK"].includes(
          (error as NodeJS.ErrnoException).code ?? ""
        )
      ) {
        throw error;
      }
      await fs.promises.copyFile(entry.source, entry.target, fs.constants.COPYFILE_FICLONE);
    }
  });
}

/** Publish an independently owned Windows resource tree. Symlinks in an
 * installed dependency closure are resolved only within that closure; the
 * result contains ordinary files so ACL changes cannot affect shared inodes. */
export async function materializePrivateTree(source: string, target: string): Promise<void> {
  const root = await fs.promises.realpath(source);
  const visit = async (
    input: string,
    output: string,
    ancestors: ReadonlySet<string>
  ): Promise<void> => {
    const resolved = await fs.promises.realpath(input);
    const relative = path.relative(root, resolved);
    if (relative === ".." || relative.startsWith(".." + path.sep) || path.isAbsolute(relative))
      throw new Error(`Dependency escapes installed resource closure: ${input}`);
    if (ancestors.has(resolved)) throw new Error(`Cyclic dependency resource link: ${input}`);
    const metadata = await fs.promises.stat(resolved);
    if (metadata.isDirectory()) {
      const next = new Set(ancestors).add(resolved);
      await fs.promises.mkdir(output, { recursive: true, mode: metadata.mode });
      for (const child of await fs.promises.readdir(resolved))
        await visit(path.join(resolved, child), path.join(output, child), next);
    } else if (metadata.isFile()) {
      await fs.promises.copyFile(resolved, output, fs.constants.COPYFILE_EXCL);
      await fs.promises.chmod(output, metadata.mode);
    } else throw new Error(`Unsupported native resource: ${input}`);
  };
  await visit(root, target, new Set());
}

/** Admit an installed SDK package's public source/declaration roots. Its
 * dependency links and package-manager workspace are never copied. */
export async function materializePackageResources(source: string, target: string): Promise<void> {
  const root = await fs.promises.realpath(source);
  const manifest = JSON.parse(
    await fs.promises.readFile(path.join(root, "package.json"), "utf8")
  ) as {
    exports?: unknown;
    types?: string;
    main?: string;
  };
  const entries = new Set(["package.json"]);
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      const relative = value.replace(/^\.\//u, "");
      if (path.isAbsolute(relative) || relative.split(/[\\/]/u).includes(".."))
        throw new Error(`SDK export escapes its package: ${value}`);
      const entry = relative.split(/[\\/]/u)[0];
      if (!entry || entry.includes("*") || entry === "node_modules")
        throw new Error(`SDK export has no owned resource root: ${value}`);
      entries.add(entry);
    } else if (value && typeof value === "object") {
      for (const child of Object.values(value)) visit(child);
    }
  };
  visit(manifest.exports);
  visit(manifest.types);
  visit(manifest.main);
  await fs.promises.mkdir(target, { recursive: true });
  for (const entry of [...entries].sort()) {
    const input = path.join(root, entry);
    const resolved = await fs.promises.realpath(input);
    const relative = path.relative(root, resolved);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
      throw new Error(`SDK resource escapes its package: ${input}`);
    const output = path.join(target, entry);
    if ((await fs.promises.stat(input)).isDirectory()) await materializePrivateTree(input, output);
    else await fs.promises.copyFile(input, output, fs.constants.COPYFILE_EXCL);
  }
}

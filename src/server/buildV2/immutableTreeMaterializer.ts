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
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      for (;;) {
        const value = values[cursor++];
        if (value === undefined) return;
        await apply(value);
      }
    })
  );
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

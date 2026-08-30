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

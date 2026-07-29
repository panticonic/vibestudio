import * as path from "node:path";

export interface AtomicCheckoutFilesystem {
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  mkdtemp(prefix: string): Promise<string>;
  rename(from: string, to: string): Promise<void>;
  rm(path: string, options: { recursive: true; force: true }): Promise<void>;
  stat(path: string): Promise<unknown>;
}

async function exists(fs: AtomicCheckoutFilesystem, target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Run one Git operation in a fresh same-filesystem directory and always remove
 * it afterwards. Moving refs are observations, not caches: callers publish only
 * the verified coordinates or bytes they derive from this attempt.
 */
export async function withTemporaryGitCheckout<T>(
  fs: AtomicCheckoutFilesystem,
  root: string,
  label: string,
  operation: (directory: string) => Promise<T>
): Promise<T> {
  await fs.mkdir(root, { recursive: true });
  const directory = await fs.mkdtemp(path.join(root, `.${label}-`));
  try {
    return await operation(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

/**
 * Populate one immutable exact-coordinate checkout through a verified
 * same-filesystem attempt, then publish it with a single directory rename.
 *
 * Concurrent attempts need no mutex. One rename wins; losers discard their
 * private attempt and read the winner. An existing coordinate is never deleted
 * or rewritten, so readers cannot observe a half-clone or have their checkout
 * removed underneath them.
 */
export async function readThroughImmutableGitCheckout<T>(input: {
  fs: AtomicCheckoutFilesystem;
  target: string;
  label: string;
  read(directory: string): Promise<T>;
  prepare(directory: string): Promise<T>;
}): Promise<T> {
  if (await exists(input.fs, input.target)) return input.read(input.target);

  const parent = path.dirname(input.target);
  await input.fs.mkdir(parent, { recursive: true });
  const attempt = await input.fs.mkdtemp(path.join(parent, `.${input.label}-`));
  let published = false;
  try {
    const prepared = await input.prepare(attempt);
    try {
      await input.fs.rename(attempt, input.target);
      published = true;
      return prepared;
    } catch (error) {
      if (!(await exists(input.fs, input.target))) throw error;
      return await input.read(input.target);
    }
  } finally {
    if (!published) {
      await input.fs.rm(attempt, { recursive: true, force: true });
    }
  }
}

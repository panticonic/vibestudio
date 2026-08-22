import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface AtomicStorageReplaceOptions {
  /** Test seam at the last crash boundary before the atomic name switch. */
  beforeRename?: () => void | Promise<void>;
}

function storageError(code: string, message: string): NodeJS.ErrnoException {
  return Object.assign(new Error(message), { code });
}

async function existingRegularFile(target: string): Promise<void> {
  try {
    const stat = await fs.lstat(target);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw storageError("EINVAL", `Atomic storage destination is not a regular file: ${target}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/**
 * Durably replaces one file below an extension's private storage root.
 *
 * The temporary file is created in the destination directory, so rename is an
 * atomic name switch on the same filesystem. Both the bytes and directory
 * entry are synced before success is reported. No caller-visible convention or
 * temporary name is exposed through ExtensionContext.
 */
export async function replaceExtensionStorageFile(
  storageRoot: string,
  relativePath: string,
  data: string | Uint8Array,
  options: AtomicStorageReplaceOptions = {}
): Promise<void> {
  const normalizedRoot = path.resolve(storageRoot);
  const lexicalTarget = path.resolve(normalizedRoot, relativePath);
  const rootWithSep = normalizedRoot.endsWith(path.sep) ? normalizedRoot : `${normalizedRoot}${path.sep}`;
  if (!lexicalTarget.startsWith(rootWithSep)) {
    throw storageError("EACCES", `Storage path escapes extension storage: ${relativePath}`);
  }

  const lexicalParent = path.dirname(lexicalTarget);
  const [realRoot, realParent] = await Promise.all([
    fs.realpath(normalizedRoot),
    fs.realpath(lexicalParent),
  ]);
  const expectedParent = path.resolve(realRoot, path.relative(normalizedRoot, lexicalParent));
  const realRootWithSep = realRoot.endsWith(path.sep) ? realRoot : `${realRoot}${path.sep}`;
  if (
    realParent !== expectedParent ||
    (realParent !== realRoot && !realParent.startsWith(realRootWithSep))
  ) {
    throw storageError("EACCES", `Storage parent contains a symbolic-link drift: ${relativePath}`);
  }

  const target = path.join(realParent, path.basename(lexicalTarget));
  await existingRegularFile(target);
  const temporary = path.join(realParent, `.${path.basename(target)}.${randomUUID()}.tmp`);
  let handle: fs.FileHandle | null = null;
  let ownsTemporary = false;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    ownsTemporary = true;
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = null;

    const currentParent = await fs.realpath(lexicalParent);
    if (currentParent !== realParent) {
      throw storageError("EACCES", `Storage parent changed during atomic replace: ${relativePath}`);
    }
    await existingRegularFile(target);
    await options.beforeRename?.();
    await fs.rename(temporary, target);
    ownsTemporary = false;

    const directory = await fs.open(realParent, "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await handle?.close().catch(() => undefined);
    if (ownsTemporary) {
      await fs.rm(temporary, { force: true }).catch(() => undefined);
    }
  }
}

import fs from "node:fs";
import path from "node:path";
import type { SecretKey } from "@number0/iroh";
import { loadIrohNodeBinding } from "./nodeBinding.js";

const SECRET_BYTES = 32;

export interface LoadEndpointSecretOptions {
  /** An advertised reach without its secret is identity corruption, never a rotation request. */
  advertisedReachExists?: boolean;
}

function fsyncDirectory(directory: string): void {
  const handle = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
}

function parseSecret(bytes: Buffer, filename: string): SecretKey {
  if (bytes.byteLength !== SECRET_BYTES) {
    throw new Error(
      `Iroh endpoint secret at ${filename} must contain exactly ${SECRET_BYTES} bytes`
    );
  }
  try {
    return loadIrohNodeBinding().SecretKey.fromBytes([...bytes]);
  } catch (error) {
    throw new Error(`Iroh endpoint secret at ${filename} is malformed`, { cause: error });
  }
}

/**
 * Load one durable endpoint identity, creating it only for genuinely new state.
 * The containing directory and secret modes are corrected before use; creation
 * is atomic and both the file and directory entry are fsynced before return.
 */
export function loadOrCreateNodeEndpointSecret(
  filename: string,
  options: LoadEndpointSecretOptions = {}
): SecretKey {
  const directory = path.dirname(filename);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  try {
    const bytes = fs.readFileSync(filename);
    fs.chmodSync(filename, 0o600);
    return parseSecret(bytes, filename);
  } catch (error) {
    const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
    if (code !== "ENOENT") throw error;
  }

  if (options.advertisedReachExists) {
    throw new Error(
      `Iroh endpoint secret is missing at ${filename} while an advertised reach still exists`
    );
  }

  const secret = loadIrohNodeBinding().SecretKey.generate();
  const temporary = path.join(directory, `.${path.basename(filename)}.${process.pid}.tmp`);
  let handle: number | null = null;
  try {
    handle = fs.openSync(
      temporary,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
      0o600
    );
    const bytes = Buffer.from(secret.toBytes());
    if (bytes.byteLength !== SECRET_BYTES)
      throw new Error("Iroh generated an invalid endpoint secret");
    fs.writeFileSync(handle, bytes);
    fs.fsyncSync(handle);
    fs.closeSync(handle);
    handle = null;
    fs.renameSync(temporary, filename);
    fs.chmodSync(filename, 0o600);
    fsyncDirectory(directory);
    return secret;
  } catch (error) {
    if (handle !== null) fs.closeSync(handle);
    try {
      fs.unlinkSync(temporary);
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== "ENOENT") throw cleanupError;
    }
    throw error;
  }
}

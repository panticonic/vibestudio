import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { getProfileDataPath } from "@vibestudio/env-paths";
import { createResilientStoreCipher } from "./storeCipher.js";
import { hasDeveloperIdSignature } from "./macCodeSignature.js";

const IDENTIFIER_RE = /^[a-zA-Z0-9][a-zA-Z0-9._@+=:-]{0,127}$/;

export function assertValidStoreIdentifier(kind: string, value: string): void {
  if (typeof value !== "string" || !IDENTIFIER_RE.test(value)) {
    throw new Error(
      `Invalid ${kind}: must be a safe path component matching /^[a-zA-Z0-9][a-zA-Z0-9._@+=:-]{0,127}$/ (got: ${JSON.stringify(value)})`
    );
  }
}

interface DirectoryEntry {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

function isNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

interface EncryptedEnvelope {
  v: string;
  ct: string;
}

function isEncryptedEnvelope(value: unknown): value is EncryptedEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { v?: unknown }).v === "string" &&
    typeof (value as { ct?: unknown }).ct === "string"
  );
}

interface SafeStorage {
  isEncryptionAvailable(): boolean;
  encryptString(s: string): Buffer;
  decryptString(b: Buffer): string;
}

let safeStorageCache: SafeStorage | null | undefined;

function tryGetSafeStorage(): SafeStorage | null {
  if (safeStorageCache !== undefined) return safeStorageCache;
  if (process.platform === "darwin" && !hasDeveloperIdSignature(process.execPath)) {
    safeStorageCache = null;
    return null;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require("electron");
    const ss: SafeStorage | undefined = electron?.safeStorage;
    if (ss && typeof ss.isEncryptionAvailable === "function" && ss.isEncryptionAvailable()) {
      safeStorageCache = ss;
      return ss;
    }
  } catch {
    /* not in Electron */
  }
  safeStorageCache = null;
  return null;
}

export function __setSafeStorageForTests(ss: SafeStorage | null): void {
  safeStorageCache = ss;
}

function getKeyFilePath(): string {
  return path.join(getProfileDataPath(), "keys", "store.key");
}

function recordCipher() {
  return createResilientStoreCipher({
    primary: {
      isAvailable: () => tryGetSafeStorage() !== null,
      encrypt: (plaintext) => {
        const ss = tryGetSafeStorage();
        if (!ss) throw new Error("OS credential cipher is unavailable");
        return Buffer.from(
          JSON.stringify({
            v: "v1-electron",
            ct: ss.encryptString(plaintext).toString("base64"),
          })
        );
      },
      decrypt: (ciphertext) => {
        const envelope = JSON.parse(ciphertext.toString("utf8")) as EncryptedEnvelope;
        if (envelope.v !== "v1-electron")
          throw new Error("Unknown encrypted JSON envelope version");
        const ss = tryGetSafeStorage();
        if (!ss) throw new Error("OS credential cipher is unavailable");
        return ss.decryptString(Buffer.from(envelope.ct, "base64"));
      },
    },
    keyPath: getKeyFilePath(),
    fs: fsSync,
    dirname: path.dirname,
    randomBytes: crypto.randomBytes,
    createCipheriv: crypto.createCipheriv,
    createDecipheriv: crypto.createDecipheriv,
  });
}

function encryptJson(plaintext: string): EncryptedEnvelope {
  return JSON.parse(recordCipher().encrypt(plaintext).toString("utf8")) as EncryptedEnvelope;
}

function decryptJson(envelope: EncryptedEnvelope): string {
  return recordCipher().decrypt(Buffer.from(JSON.stringify(envelope)));
}

function serializeRecord<TRecord>(record: TRecord): string {
  return `${JSON.stringify(encryptJson(JSON.stringify(record)))}\n`;
}

function deserializeRecord<TRecord>(raw: string): TRecord {
  const parsed = JSON.parse(raw) as unknown;
  if (!isEncryptedEnvelope(parsed)) {
    throw new Error("Record file is not an encrypted JSON envelope");
  }
  return JSON.parse(decryptJson(parsed)) as TRecord;
}

export abstract class EncryptedJsonStore<TRecord> {
  protected readonly basePath: string;

  constructor(options: { basePath?: string; defaultBasePath: string }) {
    this.basePath = options.basePath ?? options.defaultBasePath;
  }

  protected async saveRecord(
    namespaceId: string,
    recordId: string,
    record: TRecord
  ): Promise<void> {
    assertValidStoreIdentifier("namespaceId", namespaceId);
    assertValidStoreIdentifier("recordId", recordId);

    const namespaceDir = this.getNamespacePath(namespaceId);
    const targetPath = this.getRecordPath(namespaceId, recordId);
    const tempPath = path.join(
      namespaceDir,
      `.${recordId}.${process.pid}.${Date.now()}.${crypto.randomBytes(16).toString("hex")}.tmp`
    );
    const fileContents = serializeRecord(record);

    await fs.mkdir(namespaceDir, { recursive: true, mode: 0o700 });

    let handle: fs.FileHandle | null = null;
    try {
      handle = await fs.open(tempPath, "w", 0o600);
      await handle.writeFile(fileContents, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;

      await fs.chmod(tempPath, 0o600);
      await fs.rename(tempPath, targetPath);
      await fs.chmod(targetPath, 0o600);
    } catch (error) {
      if (handle) {
        await handle.close().catch(() => undefined);
      }
      await fs.rm(tempPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  protected async loadRecord(namespaceId: string, recordId: string): Promise<TRecord | null> {
    assertValidStoreIdentifier("namespaceId", namespaceId);
    assertValidStoreIdentifier("recordId", recordId);
    return this.readRecordFile(this.getRecordPath(namespaceId, recordId));
  }

  protected async listRecords(namespaceId?: string): Promise<TRecord[]> {
    if (namespaceId !== undefined) {
      assertValidStoreIdentifier("namespaceId", namespaceId);
    }
    const namespaceIds = namespaceId ? [namespaceId] : await this.listNamespaceIds();
    const records: TRecord[] = [];

    for (const currentNamespaceId of namespaceIds.sort((left, right) =>
      left.localeCompare(right)
    )) {
      if (!IDENTIFIER_RE.test(currentNamespaceId)) continue;
      const namespaceDir = this.getNamespacePath(currentNamespaceId);
      let entries: DirectoryEntry[];

      try {
        entries = await fs.readdir(namespaceDir, { withFileTypes: true });
      } catch (error) {
        if (isNotFoundError(error)) {
          continue;
        }
        throw error;
      }

      for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) {
          continue;
        }
        const recordId = entry.name.slice(0, -".json".length);
        if (!IDENTIFIER_RE.test(recordId)) continue;
        const record = await this.loadRecord(currentNamespaceId, recordId);
        if (record) {
          records.push(record);
        }
      }
    }

    return records;
  }

  protected async removeRecord(namespaceId: string, recordId: string): Promise<void> {
    assertValidStoreIdentifier("namespaceId", namespaceId);
    assertValidStoreIdentifier("recordId", recordId);
    try {
      await fs.unlink(this.getRecordPath(namespaceId, recordId));
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }
  }

  protected async collectRecordSignatures(): Promise<Map<string, string>> {
    const signatures = new Map<string, string>();
    const namespaceIds = await this.listNamespaceIds();

    for (const namespaceId of namespaceIds) {
      if (!IDENTIFIER_RE.test(namespaceId)) continue;
      const namespaceDir = this.getNamespacePath(namespaceId);
      let entries: DirectoryEntry[];

      try {
        entries = await fs.readdir(namespaceDir, { withFileTypes: true });
      } catch (error) {
        if (isNotFoundError(error)) {
          continue;
        }
        throw error;
      }

      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) {
          continue;
        }
        const recordId = entry.name.slice(0, -".json".length);
        if (!IDENTIFIER_RE.test(recordId)) continue;

        const filePath = path.join(namespaceDir, entry.name);
        try {
          const stats = await fs.stat(filePath);
          signatures.set(filePath, `${stats.mtimeMs}:${stats.size}`);
        } catch (error) {
          if (!isNotFoundError(error)) {
            throw error;
          }
        }
      }
    }

    return signatures;
  }

  protected async readRecordFile(filePath: string): Promise<TRecord | null> {
    let raw: string;
    try {
      raw = await fs.readFile(filePath, "utf8");
    } catch (error) {
      if (isNotFoundError(error)) {
        return null;
      }
      throw error;
    }

    try {
      return deserializeRecord<TRecord>(raw);
    } catch (error) {
      console.warn(
        `[EncryptedJsonStore] Ignoring unreadable record file ${filePath}: ` +
          `${error instanceof Error ? error.message : String(error)}`
      );
      return null;
    }
  }

  protected getNamespacePath(namespaceId: string): string {
    return path.join(this.basePath, namespaceId);
  }

  protected getRecordPath(namespaceId: string, recordId: string): string {
    return path.join(this.getNamespacePath(namespaceId), `${recordId}.json`);
  }

  private async listNamespaceIds(): Promise<string[]> {
    let entries: DirectoryEntry[];

    try {
      entries = await fs.readdir(this.basePath, { withFileTypes: true });
    } catch (error) {
      if (isNotFoundError(error)) {
        return [];
      }
      throw error;
    }

    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((left, right) => left.localeCompare(right));
  }
}

export function getDefaultCredentialStorePath(): string {
  return path.join(getProfileDataPath(), "credentials");
}

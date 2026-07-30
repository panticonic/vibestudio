import fs from "node:fs";

import { writeJsonFileAtomic } from "./atomicFile.js";

export interface VersionedJsonCodec<T> {
  readonly schemaName: string;
  readonly currentVersion: number;
  readonly versionKey?: string;
  decodeCurrent(value: unknown): T;
  encode(value: T): Record<string, unknown>;
}

/** Read a small JSON store only when it has the exact current schema version. */
export function loadVersionedJsonFile<T>(filePath: string, codec: VersionedJsonCodec<T>): T | null {
  validateCodec(codec);
  const versionKey = codec.versionKey ?? "schemaVersion";
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${codec.schemaName} contains malformed JSON`, { cause: error });
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !(versionKey in parsed)) {
    throw new Error(`${codec.schemaName} has no ${versionKey}`);
  }
  const storedVersion = (parsed as Record<string, unknown>)[versionKey];
  if (storedVersion !== codec.currentVersion) {
    throw new Error(
      `${codec.schemaName} has schema version ${String(storedVersion)}; expected ${codec.currentVersion}`
    );
  }
  return codec.decodeCurrent(parsed);
}

export function saveVersionedJsonFile<T>(
  filePath: string,
  value: T,
  codec: VersionedJsonCodec<T>
): void {
  validateCodec(codec);
  writeCurrent(filePath, value, codec);
}

function writeCurrent<T>(filePath: string, value: T, codec: VersionedJsonCodec<T>): void {
  const versionKey = codec.versionKey ?? "schemaVersion";
  const body = validateBody(codec, versionKey, codec.encode(value), "encoder");
  writeJsonFileAtomic(filePath, {
    [versionKey]: codec.currentVersion,
    ...body,
  });
}

function validateBody<T>(
  codec: VersionedJsonCodec<T>,
  versionKey: string,
  body: unknown,
  source: string
): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body) || versionKey in body) {
    throw new Error(`${codec.schemaName} ${source} returned an invalid body`);
  }
  return body as Record<string, unknown>;
}

function validateCodec<T>(codec: VersionedJsonCodec<T>): void {
  if (!Number.isSafeInteger(codec.currentVersion) || codec.currentVersion < 1) {
    throw new Error(
      `${codec.schemaName} has invalid current schema version ${codec.currentVersion}`
    );
  }
  const versionKey = codec.versionKey ?? "schemaVersion";
  if (!versionKey) throw new Error(`${codec.schemaName} has an empty version field name`);
}

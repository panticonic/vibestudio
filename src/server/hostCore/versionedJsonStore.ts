import fs from "node:fs";

import { writeJsonFileAtomic } from "./atomicFile.js";

export interface VersionedJsonCodec<T> {
  readonly schemaName: string;
  readonly currentVersion: number;
  readonly versionKey?: string;
  readonly migrations?: readonly VersionedJsonMigration[];
  readonly unversionedMigration?: VersionedJsonMigration;
  decodeCurrent(value: unknown): T;
  encode(value: T): Record<string, unknown>;
}

export interface VersionedJsonMigration {
  /** Version produced by this migration. Versioned inputs must be version - 1. */
  readonly version: number;
  readonly name: string;
  /** Return the migrated body without the configured version field. */
  migrate(value: unknown): Record<string, unknown>;
}

/** Read and, when recognized, atomically migrate a small versioned JSON store. */
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

  let version: number;
  let migrated = false;
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && versionKey in parsed) {
    const storedVersion = (parsed as Record<string, unknown>)[versionKey];
    if (!Number.isSafeInteger(storedVersion) || (storedVersion as number) < 1) {
      throw new Error(`${codec.schemaName} has invalid ${versionKey} ${String(storedVersion)}`);
    }
    version = storedVersion as number;
    if (version > codec.currentVersion) {
      throw new Error(
        `${codec.schemaName} has unsupported schema version ${version}; this binary supports ${codec.currentVersion}`
      );
    }
  } else {
    const migration = codec.unversionedMigration;
    if (!migration) {
      throw new Error(`${codec.schemaName} is unversioned and has no declared migration`);
    }
    parsed = applyMigration(codec, versionKey, migration, parsed);
    version = migration.version;
    migrated = true;
  }

  const migrations = new Map(
    (codec.migrations ?? []).map((migration) => [migration.version, migration])
  );
  while (version < codec.currentVersion) {
    const migration = migrations.get(version + 1);
    if (!migration) {
      throw new Error(
        `${codec.schemaName} schema version ${version} predates the supported production baseline or has no declared migration to version ${version + 1}`
      );
    }
    parsed = applyMigration(codec, versionKey, migration, parsed);
    version = migration.version;
    migrated = true;
  }

  const decoded = codec.decodeCurrent(parsed);
  if (migrated) writeCurrent(filePath, decoded, codec);
  return decoded;
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

function applyMigration<T>(
  codec: VersionedJsonCodec<T>,
  versionKey: string,
  migration: VersionedJsonMigration,
  value: unknown
): Record<string, unknown> {
  const body = validateBody(
    codec,
    versionKey,
    migration.migrate(value),
    `migration ${migration.version} (${migration.name})`
  );
  return { [versionKey]: migration.version, ...body };
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
  let previous = 0;
  const names = new Set<string>();
  const migrations = codec.migrations ?? [];
  for (const migration of migrations) {
    if (
      !Number.isSafeInteger(migration.version) ||
      migration.version < 1 ||
      migration.version > codec.currentVersion ||
      migration.version <= previous ||
      (previous !== 0 && migration.version !== previous + 1) ||
      !migration.name.trim() ||
      names.has(migration.name)
    ) {
      throw new Error(
        `${codec.schemaName} has invalid or unordered migration ${migration.version} (${migration.name})`
      );
    }
    previous = migration.version;
    names.add(migration.name);
  }
  if (migrations.length > 0 && previous !== codec.currentVersion) {
    throw new Error(
      `${codec.schemaName} migration chain ends at ${previous}, not current version ${codec.currentVersion}`
    );
  }
  const unversioned = codec.unversionedMigration;
  if (
    unversioned &&
    (!Number.isSafeInteger(unversioned.version) ||
      unversioned.version < 1 ||
      unversioned.version > codec.currentVersion ||
      !unversioned.name.trim() ||
      names.has(unversioned.name))
  ) {
    throw new Error(`${codec.schemaName} has an invalid unversioned migration`);
  }
  const firstMigration = migrations.at(0);
  if (unversioned && firstMigration && unversioned.version < firstMigration.version - 1) {
    throw new Error(
      `${codec.schemaName} unversioned migration does not connect to its versioned migration chain`
    );
  }
}

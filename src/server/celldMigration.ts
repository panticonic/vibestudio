/**
 * One-time migration of a workspace's Durable Object storage from the retired
 * workerd runtime into celld cells (audit V6).
 *
 * workerd kept each object as `<hash>.sqlite` (and `<hash>.1.sqlite`, the
 * `do` facet, for userland objects hosted by UniversalDO), where hash is an
 * HMAC of the object's name under its namespace's unique key. The hash is
 * one-way, so the names come from the workspace's own records: its retained
 * WorkspaceDO database lists every Durable Object entity (source, class, key).
 *
 *  - a userland object is the UniversalDO cell named `encodeUniversalKey(ref)`,
 *    its root database imported as the cell's root and its `.1.sqlite` as the
 *    facet `do`;
 *  - a product object is the cell `objectKey` of its class.
 *
 * The import is `celld cell import`, which also converts workerd's KV tables.
 * The migration is idempotent per object (an existing cell is left alone), is
 * recorded in a marker so a completed one is not repeated, and never deletes
 * the legacy files. Files it cannot name (no entity, no known key) are
 * reported and left in place.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { encodeUniversalKey } from "./doDispatch.js";
import { INTERNAL_DO_SOURCE } from "./internalDOs/internalDoLoader.js";
import { RUNTIME_SCRIPT } from "./runtimeNames.js";

/** workerd's namespace key of the userland host (one directory under the universal dir). */
const UNIVERSAL_DO_UNIQUE_KEY = "vibestudio-universal-do";

/** workerd's per-namespace directory for a product class. */
function internalDoUniqueKey(source: string, className: string): string {
  return crypto.createHash("sha256").update(JSON.stringify([source, className])).digest("hex");
}

/**
 * workerd's idFromName() -> SQLite filename derivation:
 * key = SHA-256(uniqueKey); base = HMAC(key, name)[0..16];
 * mac = HMAC(key, base)[0..16]; filename = hex(base || mac).
 */
export function legacyWorkerdObjectHash(uniqueKey: string, objectName: string): string {
  const key = crypto.createHash("sha256").update(uniqueKey).digest();
  const base = crypto.createHmac("sha256", key).update(objectName).digest().subarray(0, 16);
  const mac = crypto.createHmac("sha256", key).update(base).digest().subarray(0, 16);
  return Buffer.concat([base, mac]).toString("hex");
}

export interface LegacyStorageLayout {
  /** `workerd-do`: one directory per product class. */
  readonly legacyWorkerdDoDir: string;
  /** `workerd-universal-do`: holds the one UniversalDO namespace directory. */
  readonly legacyWorkerdUniversalDoDir: string;
}

export interface CellImporter {
  importCell(input: {
    script: string;
    className: string;
    name: string;
    root: string;
    facets?: Readonly<Record<string, string>>;
  }): Promise<"imported" | "exists">;
}

export interface LegacyMigrationReport {
  readonly state: "none" | "already-complete" | "migrated";
  readonly imported: ReadonlyArray<{ readonly cell: string; readonly name: string }>;
  readonly existing: ReadonlyArray<{ readonly cell: string; readonly name: string }>;
  /** Legacy databases no entity or known key names; left untouched. */
  readonly unmapped: ReadonlyArray<{ readonly directory: string; readonly files: number }>;
}

interface Candidate {
  readonly source: string;
  readonly className: string;
  readonly objectKey: string;
}

const MARKER = "legacy-migration.json";

function legacyDatabases(directory: string): string[] {
  try {
    return fs
      .readdirSync(directory)
      .filter((file) => /^[0-9a-f]{64}\.sqlite$/u.test(file))
      .map((file) => file.slice(0, 64));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** Entity rows of the workspace's retained WorkspaceDO database. */
function legacyEntities(workspaceDatabase: string): Candidate[] {
  if (!fs.existsSync(workspaceDatabase)) return [];
  const database = new DatabaseSync(workspaceDatabase, { readOnly: true });
  try {
    const present = database
      .prepare(`SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'entities'`)
      .get();
    if (!present) return [];
    return database
      .prepare(
        `SELECT source_repo_path, class_name, key FROM entities WHERE kind = 'do' AND class_name IS NOT NULL`
      )
      .all()
      .map((row) => {
        const entity = row as { source_repo_path: string; class_name: string; key: string };
        return {
          source: entity.source_repo_path,
          className: entity.class_name,
          objectKey: entity.key,
        };
      });
  } finally {
    database.close();
  }
}

export async function migrateLegacyWorkerdStorage(input: {
  readonly layout: LegacyStorageLayout;
  /** Directory the marker lives in (the node's own state). */
  readonly stateDir: string;
  readonly workspaceId: string;
  readonly internalClasses: readonly string[];
  readonly importer: CellImporter;
  readonly script?: string;
  readonly log?: (message: string) => void;
}): Promise<LegacyMigrationReport> {
  const log = input.log ?? (() => undefined);
  const script = input.script ?? RUNTIME_SCRIPT;
  const universalDir = path.join(input.layout.legacyWorkerdUniversalDoDir, UNIVERSAL_DO_UNIQUE_KEY);
  const marker = path.join(input.stateDir, MARKER);
  const empty = { imported: [], existing: [], unmapped: [] } as const;
  if (fs.existsSync(marker)) return { state: "already-complete", ...empty };
  const hasLegacy =
    legacyDatabases(universalDir).length > 0 ||
    input.internalClasses.some(
      (className) =>
        legacyDatabases(
          path.join(input.layout.legacyWorkerdDoDir, internalDoUniqueKey(INTERNAL_DO_SOURCE, className))
        ).length > 0
    );
  if (!hasLegacy) return { state: "none", ...empty };

  const imported: Array<{ cell: string; name: string }> = [];
  const existing: Array<{ cell: string; name: string }> = [];
  const mapped = new Map<string, Set<string>>();
  const claim = (directory: string, hash: string): void => {
    const set = mapped.get(directory) ?? new Set<string>();
    set.add(hash);
    mapped.set(directory, set);
  };

  // The workspace's own record names every object; its database is found by
  // its known key.
  const workspaceDir = path.join(
    input.layout.legacyWorkerdDoDir,
    internalDoUniqueKey(INTERNAL_DO_SOURCE, "WorkspaceDO")
  );
  const workspaceHash = legacyWorkerdObjectHash(
    internalDoUniqueKey(INTERNAL_DO_SOURCE, "WorkspaceDO"),
    input.workspaceId
  );
  const candidates: Candidate[] = [
    { source: INTERNAL_DO_SOURCE, className: "WorkspaceDO", objectKey: input.workspaceId },
    ...legacyEntities(path.join(workspaceDir, `${workspaceHash}.sqlite`)),
  ];
  const seen = new Set<string>();
  const record = (result: "imported" | "exists", cell: string, name: string) =>
    (result === "imported" ? imported : existing).push({ cell, name });

  for (const candidate of candidates) {
    const identity = JSON.stringify([candidate.source, candidate.className, candidate.objectKey]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    if (candidate.source === INTERNAL_DO_SOURCE) {
      if (!input.internalClasses.includes(candidate.className)) continue;
      const uniqueKey = internalDoUniqueKey(candidate.source, candidate.className);
      const directory = path.join(input.layout.legacyWorkerdDoDir, uniqueKey);
      const hash = legacyWorkerdObjectHash(uniqueKey, candidate.objectKey);
      const root = path.join(directory, `${hash}.sqlite`);
      if (!fs.existsSync(root)) continue;
      claim(directory, hash);
      const result = await input.importer.importCell({
        script,
        className: candidate.className,
        name: candidate.objectKey,
        root,
      });
      record(result, candidate.className, candidate.objectKey);
      log(`legacy ${candidate.className}/${candidate.objectKey}: ${result}`);
      continue;
    }
    const name = encodeUniversalKey(candidate);
    const hash = legacyWorkerdObjectHash(UNIVERSAL_DO_UNIQUE_KEY, name);
    const root = path.join(universalDir, `${hash}.sqlite`);
    if (!fs.existsSync(root)) continue;
    claim(universalDir, hash);
    const facet = path.join(universalDir, `${hash}.1.sqlite`);
    const result = await input.importer.importCell({
      script,
      className: "UniversalDO",
      name,
      root,
      ...(fs.existsSync(facet) ? { facets: { do: facet } } : {}),
    });
    record(result, "UniversalDO", name);
    log(`legacy ${candidate.className}/${candidate.objectKey}: ${result}`);
  }

  const unmapped: Array<{ directory: string; files: number }> = [];
  const directories = [
    universalDir,
    ...input.internalClasses.map((className) =>
      path.join(input.layout.legacyWorkerdDoDir, internalDoUniqueKey(INTERNAL_DO_SOURCE, className))
    ),
  ];
  for (const directory of directories) {
    const left = legacyDatabases(directory).filter((hash) => !mapped.get(directory)?.has(hash));
    if (left.length > 0) {
      unmapped.push({ directory, files: left.length });
      log(`legacy ${directory}: ${left.length} database(s) no record names; left in place`);
    }
  }
  fs.mkdirSync(input.stateDir, { recursive: true });
  fs.writeFileSync(
    marker,
    JSON.stringify({ at: new Date().toISOString(), imported, existing, unmapped }, null, 2),
    { mode: 0o600 }
  );
  return { state: "migrated", imported, existing, unmapped };
}

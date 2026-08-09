import * as path from "node:path";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import { getCentralDataPath, getSharedDerivedDataPath } from "@vibestudio/env-paths";
import { sha256Canonical } from "@vibestudio/shared/authority/invocationSnapshot";
import { writeJsonFileAtomic } from "../hostCore/atomicFile.js";
import {
  authorityDependencyIndexDigest,
  type AuthorityAnalysisEpoch,
  type AuthorityDependencyIndex,
} from "./authorityDependencyIndex.js";
import type { WorkspaceServiceCallFact } from "./userlandAuthorityAnalyzer.js";

const CACHE_VERSION = 3 as const;
const MAX_FACTS = 256;
const MAX_INDEXES = 8;
const MAX_DIAGNOSTIC_IDENTITIES = 8;
const MAX_SHARED_FACTS = 4_096;
const MAX_SHARED_INDEXES = 256;
const MAX_SHARED_POINTERS = 4_096;
const COMMITS_BETWEEN_PRUNES = 32;

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface AuthorityIndexIdentity {
  stateHash: string;
  epoch: AuthorityAnalysisEpoch;
  environmentDigest: string;
  graphDigest: string;
  consumerSource: "analyzer-facts" | "manifest-declarations";
}

/** Provider-independent source-call facts only change with analyzer semantics.
 * Provider RPC/catalog changes invalidate the folded index through its exact
 * environment identity instead of invalidating every consumer fact. */
export interface AuthorityFactEpoch {
  analyzerVersion: string;
}

export interface AuthorityConsumerIdentity {
  epoch: AuthorityFactEpoch;
  unitName: string;
  effectiveVersion: string;
  moduleClosureDigest: string;
}

export type AuthorityConsumerBaseIdentity = Omit<AuthorityConsumerIdentity, "moduleClosureDigest">;

export interface AuthorityCompilerDependency {
  /** Absolute host path used by TypeScript resolution/configuration. */
  path: string;
  /** SHA-256 of the exact bytes consumed at analysis time. */
  contentHash: string;
}

export interface CachedAuthorityFacts {
  identity: AuthorityConsumerIdentity;
  dependencies: readonly AuthorityCompilerDependency[];
  facts: WorkspaceServiceCallFact[];
}

interface StoredFact {
  key: string;
  identity: AuthorityConsumerIdentity;
  dependencies: AuthorityCompilerDependency[];
  facts: JsonValue;
  digest: string;
}

interface StoredIndex {
  key: string;
  identity: AuthorityIndexIdentity;
  index: JsonValue;
  digest: string;
}

interface StoredFactCandidate {
  baseIdentity: AuthorityConsumerBaseIdentity;
  factKey: string;
  digest: string;
}

interface StoredDiagnosticIdentities {
  unitName: string;
  identities: Array<{ identity: AuthorityConsumerIdentity; factKey: string }>;
  digest: string;
}

export type AuthorityFactCacheReason =
  /** No stable identity to key on, so the unit is never stored or looked up. */
  | "unit-not-cacheable"
  | "no-candidate-ever-stored"
  | "candidate-for-other-epoch"
  | "candidate-for-other-effective-version"
  | "candidate-pointer-corrupt-or-missing"
  | "fact-corrupt"
  | "compiler-dependency-changed"
  | "hit-local"
  | "hit-shared";

export interface AuthorityFactCacheLookup {
  facts: CachedAuthorityFacts | null;
  reason: AuthorityFactCacheReason;
  firstDifferingPath?: string;
}

export interface AuthorityIndexCacheLookup {
  index: AuthorityDependencyIndex | null;
  source: "local" | "shared" | null;
  reason: "hit" | "missing" | "invalid";
}

interface CacheFile {
  version: typeof CACHE_VERSION;
  facts: StoredFact[];
  indexes: StoredIndex[];
}

function encodeStructured(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Authority cache cannot encode non-finite number");
    return value;
  }
  if (Array.isArray(value)) return value.map(encodeStructured);
  if (value instanceof Set) {
    const values = [...value].map(encodeStructured);
    values.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return { $set: values };
  }
  if (value instanceof Map) {
    const entries = [...value.entries()].map(([key, child]) => [key, encodeStructured(child)]);
    entries.sort(([a], [b]) => String(a).localeCompare(String(b)));
    return { $map: entries as JsonValue[] };
  }
  if (value && typeof value === "object") {
    const encoded: Record<string, JsonValue> = {};
    for (const [key, child] of Object.entries(value)) {
      if (child !== undefined) encoded[key] = encodeStructured(child);
    }
    return encoded;
  }
  throw new Error(`Authority cache cannot encode ${typeof value}`);
}

function decodeStructured(value: JsonValue): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(decodeStructured);
  if (Object.keys(value).length === 1 && Array.isArray(value["$set"])) {
    return new Set(value["$set"].map(decodeStructured));
  }
  if (Object.keys(value).length === 1 && Array.isArray(value["$map"])) {
    return new Map(
      value["$map"].map((entry) => {
        if (
          !Array.isArray(entry) ||
          entry.length !== 2 ||
          typeof entry[0] !== "string" ||
          entry[1] === undefined
        ) {
          throw new Error("Invalid authority cache map entry");
        }
        return [entry[0], decodeStructured(entry[1])] as const;
      })
    );
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, decodeStructured(child)])
  );
}

function factKey(identity: AuthorityConsumerIdentity): string {
  return sha256Canonical(identity);
}

function factBaseKey(identity: AuthorityConsumerBaseIdentity): string {
  return sha256Canonical(identity);
}

function indexKey(identity: AuthorityIndexIdentity): string {
  return sha256Canonical(identity);
}

function validEpoch(value: unknown): value is AuthorityAnalysisEpoch {
  if (!value || typeof value !== "object") return false;
  const epoch = value as Record<string, unknown>;
  return (
    typeof epoch["analyzerVersion"] === "string" && typeof epoch["rpcSchemaVersion"] === "string"
  );
}

function validFactEpoch(value: unknown): value is AuthorityFactEpoch {
  if (!value || typeof value !== "object") return false;
  const epoch = value as Record<string, unknown>;
  return Object.keys(epoch).length === 1 && typeof epoch["analyzerVersion"] === "string";
}

function validConsumerIdentity(value: unknown): value is AuthorityConsumerIdentity {
  if (!value || typeof value !== "object") return false;
  const identity = value as Record<string, unknown>;
  return (
    validFactEpoch(identity["epoch"]) &&
    typeof identity["unitName"] === "string" &&
    typeof identity["effectiveVersion"] === "string" &&
    typeof identity["moduleClosureDigest"] === "string"
  );
}

function validCompilerDependencies(value: unknown): value is AuthorityCompilerDependency[] {
  return (
    Array.isArray(value) &&
    value.every(
      (dependency) =>
        !!dependency &&
        typeof dependency === "object" &&
        typeof dependency.path === "string" &&
        path.isAbsolute(dependency.path) &&
        typeof dependency.contentHash === "string"
    )
  );
}

function sameConsumerBase(
  identity: AuthorityConsumerIdentity,
  base: AuthorityConsumerBaseIdentity
): boolean {
  return (
    identity.unitName === base.unitName &&
    identity.effectiveVersion === base.effectiveVersion &&
    sameIdentity(identity.epoch, base.epoch)
  );
}

export class AuthorityCacheValidation {
  private readonly hashes = new Map<string, string | null>();

  hash(filePath: string): string | null {
    if (this.hashes.has(filePath)) return this.hashes.get(filePath) ?? null;
    let hash: string | null = null;
    try {
      hash = crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
    } catch {
      // Missing/unreadable inputs invalidate only the dependent cache entries.
    }
    this.hashes.set(filePath, hash);
    return hash;
  }
}

function dependenciesCurrent(
  dependencies: readonly AuthorityCompilerDependency[],
  validation: AuthorityCacheValidation
): boolean {
  try {
    return dependencies.every(
      (dependency) => validation.hash(dependency.path) === dependency.contentHash
    );
  } catch {
    return false;
  }
}

function firstChangedDependency(
  dependencies: readonly AuthorityCompilerDependency[],
  validation: AuthorityCacheValidation
): string | undefined {
  return dependencies.find(
    (dependency) => validation.hash(dependency.path) !== dependency.contentHash
  )?.path;
}

function validIndexIdentity(value: unknown): value is AuthorityIndexIdentity {
  if (!value || typeof value !== "object") return false;
  const identity = value as Record<string, unknown>;
  return (
    typeof identity["stateHash"] === "string" &&
    validEpoch(identity["epoch"]) &&
    typeof identity["environmentDigest"] === "string" &&
    typeof identity["graphDigest"] === "string" &&
    (identity["consumerSource"] === "analyzer-facts" ||
      identity["consumerSource"] === "manifest-declarations")
  );
}

function validFacts(value: unknown): value is WorkspaceServiceCallFact[] {
  return (
    Array.isArray(value) &&
    value.every((fact) => {
      if (!fact || typeof fact !== "object") return false;
      const row = fact as Record<string, unknown>;
      return (
        typeof row["id"] === "string" &&
        (row["kind"] === "resolution" || row["kind"] === "invocation") &&
        row["serviceQueries"] instanceof Object &&
        row["methods"] instanceof Object &&
        Array.isArray(row["arguments"]) &&
        !!row["origin"] &&
        typeof row["origin"] === "object"
      );
    })
  );
}

function validIndex(value: unknown): value is AuthorityDependencyIndex {
  if (!value || typeof value !== "object") return false;
  const index = value as AuthorityDependencyIndex;
  return (
    typeof index.stateHash === "string" &&
    validEpoch(index.epoch) &&
    index.complete === true &&
    index.consumerInputs instanceof Map &&
    index.providersByQuery instanceof Map &&
    index.consumersByQuery instanceof Map &&
    index.consumersByProviderUnit instanceof Map &&
    index.blockingConsumers instanceof Set &&
    index.blockingConsumers.size === 0 &&
    typeof index.digest === "string"
  );
}

function sameIdentity(a: unknown, b: unknown): boolean {
  return sha256Canonical(a) === sha256Canonical(b);
}

function trimNewest<T>(values: T[], maximum: number): T[] {
  return values.length <= maximum ? values : values.slice(values.length - maximum);
}

function jsonFilesBelow(root: string): string[] {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const child = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(child);
      else if (entry.isFile() && entry.name.endsWith(".json")) files.push(child);
    }
  }
  return files;
}

function pruneDerivedFiles(root: string, maximum: number): void {
  const files = jsonFilesBelow(root);
  if (files.length <= maximum) return;
  const oldestFirst = files
    .map((file) => {
      try {
        return { file, modified: fs.statSync(file).mtimeMs };
      } catch {
        return { file, modified: 0 };
      }
    })
    .sort((a, b) => a.modified - b.modified || a.file.localeCompare(b.file));
  for (const { file } of oldestFirst.slice(0, files.length - maximum)) {
    try {
      fs.rmSync(file);
    } catch {
      // Raced derived data is already effectively pruned.
    }
  }
}

export function authorityModuleClosureDigest(input: {
  epoch: AuthorityFactEpoch;
  unitName: string;
  effectiveVersion: string;
  compilerDependencies: readonly AuthorityCompilerDependency[];
}): string {
  return sha256Canonical({ version: 2, ...input });
}

/**
 * Deletable derived-data cache. Every accepted hit is matched against exact
 * recomputed identities; cache absence/corruption only costs analysis work.
 */
export class AuthorityAnalysisCache {
  private facts: StoredFact[] = [];
  private indexes: StoredIndex[] = [];
  private loaded = false;
  private commitsSincePrune = 0;

  constructor(
    private readonly filePath: string,
    private readonly sharedFactsDir?: string
  ) {}

  static forWorkspace(workspaceId: string): AuthorityAnalysisCache {
    const workspaceKey = sha256Canonical({ workspaceId });
    const localCacheRoot = path.join(getCentralDataPath(), "authority-analysis");
    const sharedCacheRoot = path.join(getSharedDerivedDataPath(), "authority-analysis");
    return new AuthorityAnalysisCache(
      path.join(localCacheRoot, `${workspaceKey}.json`),
      path.join(sharedCacheRoot, "facts")
    );
  }

  private sharedFactPath(key: string): string | null {
    return this.sharedFactsDir
      ? path.join(this.sharedFactsDir, key.slice(0, 2), `${key}.json`)
      : null;
  }

  private sharedCandidatePath(baseKey: string): string | null {
    return this.sharedFactsDir
      ? path.join(this.sharedFactsDir, "candidates", baseKey.slice(0, 2), `${baseKey}.json`)
      : null;
  }

  private sharedIndexPath(key: string): string | null {
    return this.sharedFactsDir
      ? path.join(path.dirname(this.sharedFactsDir), "indexes", key.slice(0, 2), `${key}.json`)
      : null;
  }

  private diagnosticIdentityPath(unitName: string): string | null {
    if (!this.sharedFactsDir) return null;
    const key = sha256Canonical({ unitName });
    return path.join(this.sharedFactsDir, "diagnostics", key.slice(0, 2), `${key}.json`);
  }

  private diagnosticIdentities(unitName: string): StoredDiagnosticIdentities | null {
    const diagnosticPath = this.diagnosticIdentityPath(unitName);
    if (!diagnosticPath) return null;
    try {
      const stored = JSON.parse(
        fs.readFileSync(diagnosticPath, "utf8")
      ) as StoredDiagnosticIdentities;
      if (
        stored.unitName !== unitName ||
        !Array.isArray(stored.identities) ||
        stored.digest !==
          sha256Canonical({ unitName: stored.unitName, identities: stored.identities })
      )
        return null;
      return stored;
    } catch {
      return null;
    }
  }

  private recordDiagnosticIdentity(identity: AuthorityConsumerIdentity, key: string): void {
    const diagnosticPath = this.diagnosticIdentityPath(identity.unitName);
    if (!diagnosticPath) return;
    const previous = this.diagnosticIdentities(identity.unitName)?.identities ?? [];
    const identities = trimNewest(
      previous
        .filter((entry) => !sameIdentity(entry.identity, identity))
        .concat({ identity, factKey: key }),
      MAX_DIAGNOSTIC_IDENTITIES
    );
    writeJsonFileAtomic(diagnosticPath, {
      unitName: identity.unitName,
      identities,
      digest: sha256Canonical({ unitName: identity.unitName, identities }),
    } satisfies StoredDiagnosticIdentities);
  }

  /**
   * Pruning walks every derived file in the shared store, so doing it on each
   * commit costs O(store) syscalls per commit. The bounds are soft caps on
   * deletable derived data; checking them periodically keeps the store bounded
   * without paying a full walk for every write.
   */
  private pruneSharedStoreIfDue(): void {
    if (this.commitsSincePrune > 0 && this.commitsSincePrune < COMMITS_BETWEEN_PRUNES) {
      this.commitsSincePrune += 1;
      return;
    }
    this.commitsSincePrune = 1;
    this.pruneSharedStore();
  }

  private pruneSharedStore(): void {
    if (!this.sharedFactsDir) return;
    const factsRoot = this.sharedFactsDir;
    const contentFacts = jsonFilesBelow(factsRoot).filter(
      (file) =>
        !file.startsWith(path.join(factsRoot, "candidates") + path.sep) &&
        !file.startsWith(path.join(factsRoot, "diagnostics") + path.sep)
    );
    if (contentFacts.length > MAX_SHARED_FACTS) {
      const oldest = contentFacts
        .map((file) => {
          try {
            return { file, modified: fs.statSync(file).mtimeMs };
          } catch {
            return { file, modified: 0 };
          }
        })
        .sort((a, b) => a.modified - b.modified || a.file.localeCompare(b.file));
      for (const { file } of oldest.slice(0, contentFacts.length - MAX_SHARED_FACTS)) {
        try {
          fs.rmSync(file);
        } catch {
          // Derived cache eviction is best effort.
        }
      }
    }
    pruneDerivedFiles(path.join(factsRoot, "candidates"), MAX_SHARED_POINTERS);
    pruneDerivedFiles(path.join(factsRoot, "diagnostics"), MAX_SHARED_POINTERS);
    pruneDerivedFiles(path.join(path.dirname(factsRoot), "indexes"), MAX_SHARED_INDEXES);
  }

  private decodeFactEntry(
    entry: StoredFact | undefined,
    key: string,
    identity: AuthorityConsumerIdentity,
    validation: AuthorityCacheValidation
  ): CachedAuthorityFacts | null {
    if (!entry) return null;
    try {
      if (
        entry.key !== key ||
        !validConsumerIdentity(entry.identity) ||
        !sameIdentity(entry.identity, identity) ||
        !validCompilerDependencies(entry.dependencies) ||
        !dependenciesCurrent(entry.dependencies, validation)
      )
        return null;
      if (
        entry.digest !==
        sha256Canonical({
          key,
          identity: entry.identity,
          dependencies: entry.dependencies,
          facts: entry.facts,
        })
      )
        return null;
      const facts = decodeStructured(entry.facts);
      if (!validFacts(facts)) return null;
      return { identity, dependencies: entry.dependencies, facts };
    } catch {
      return null;
    }
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (!fs.existsSync(this.filePath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<CacheFile>;
      if (
        parsed.version !== CACHE_VERSION ||
        !Array.isArray(parsed.facts) ||
        !Array.isArray(parsed.indexes)
      )
        return;
      this.facts = parsed.facts.filter((entry) => entry && typeof entry === "object");
      this.indexes = parsed.indexes.filter((entry) => entry && typeof entry === "object");
    } catch {
      this.facts = [];
      this.indexes = [];
    }
  }

  validation(): AuthorityCacheValidation {
    return new AuthorityCacheValidation();
  }

  fact(
    identity: AuthorityConsumerIdentity,
    validation = this.validation()
  ): CachedAuthorityFacts | null {
    this.load();
    const key = factKey(identity);
    const offset = this.facts.findIndex((entry) => entry.key === key);
    const local =
      offset >= 0 ? this.decodeFactEntry(this.facts[offset], key, identity, validation) : null;
    if (local) {
      const entry = this.facts[offset]!;
      this.facts.splice(offset, 1);
      this.facts.push(entry);
      return local;
    }
    const sharedPath = this.sharedFactPath(key);
    if (!sharedPath) return null;
    try {
      if (!fs.existsSync(sharedPath)) return null;
      const shared = this.decodeFactEntry(
        JSON.parse(fs.readFileSync(sharedPath, "utf8")) as StoredFact,
        key,
        identity,
        validation
      );
      if (!shared) return null;
      return shared;
    } catch {
      return null;
    }
  }

  factForConsumer(
    base: AuthorityConsumerBaseIdentity,
    validation = this.validation()
  ): CachedAuthorityFacts | null {
    return this.factForConsumerDetailed(base, validation).facts;
  }

  factForConsumerDetailed(
    base: AuthorityConsumerBaseIdentity,
    validation = this.validation()
  ): AuthorityFactCacheLookup {
    this.load();
    for (let offset = this.facts.length - 1; offset >= 0; offset -= 1) {
      const entry = this.facts[offset];
      if (
        !entry ||
        !validConsumerIdentity(entry.identity) ||
        !sameConsumerBase(entry.identity, base)
      )
        continue;
      const decoded = this.decodeFactEntry(entry, entry.key, entry.identity, validation);
      if (!decoded) {
        const firstDifferingPath = firstChangedDependency(entry.dependencies, validation);
        if (firstDifferingPath) {
          return { facts: null, reason: "compiler-dependency-changed", firstDifferingPath };
        }
        return { facts: null, reason: "fact-corrupt" };
      }
      this.facts.splice(offset, 1);
      this.facts.push(entry);
      return { facts: decoded, reason: "hit-local" };
    }
    const candidatePath = this.sharedCandidatePath(factBaseKey(base));
    if (!candidatePath) return { facts: null, reason: "no-candidate-ever-stored" };
    try {
      const candidate = JSON.parse(fs.readFileSync(candidatePath, "utf8")) as StoredFactCandidate;
      if (
        !candidate ||
        typeof candidate.factKey !== "string" ||
        !sameIdentity(candidate.baseIdentity, base) ||
        candidate.digest !==
          sha256Canonical({ baseIdentity: candidate.baseIdentity, factKey: candidate.factKey })
      )
        return { facts: null, reason: "candidate-pointer-corrupt-or-missing" };
      const sharedPath = this.sharedFactPath(candidate.factKey);
      if (!sharedPath) return { facts: null, reason: "candidate-pointer-corrupt-or-missing" };
      const entry = JSON.parse(fs.readFileSync(sharedPath, "utf8")) as StoredFact;
      if (!validConsumerIdentity(entry.identity) || !sameConsumerBase(entry.identity, base))
        return { facts: null, reason: "fact-corrupt" };
      const decoded = this.decodeFactEntry(entry, candidate.factKey, entry.identity, validation);
      if (decoded) return { facts: decoded, reason: "hit-shared" };
      const firstDifferingPath = firstChangedDependency(entry.dependencies, validation);
      return firstDifferingPath
        ? { facts: null, reason: "compiler-dependency-changed", firstDifferingPath }
        : { facts: null, reason: "fact-corrupt" };
    } catch {
      const recent = this.diagnosticIdentities(base.unitName)?.identities ?? [];
      if (recent.length === 0) return { facts: null, reason: "no-candidate-ever-stored" };
      const sameEpoch = recent.filter((entry) => sameIdentity(entry.identity.epoch, base.epoch));
      if (sameEpoch.length === 0) return { facts: null, reason: "candidate-for-other-epoch" };
      if (sameEpoch.every((entry) => entry.identity.effectiveVersion !== base.effectiveVersion)) {
        return { facts: null, reason: "candidate-for-other-effective-version" };
      }
      return { facts: null, reason: "candidate-pointer-corrupt-or-missing" };
    }
  }

  index(
    identity: AuthorityIndexIdentity,
    expectedConsumers: ReadonlyMap<
      string,
      { effectiveVersion: string; moduleClosureDigest?: string }
    >,
    validation = this.validation()
  ): AuthorityDependencyIndex | null {
    this.load();
    const key = indexKey(identity);
    let entry = this.indexes.find((candidate) => candidate.key === key);
    if (!entry) {
      const sharedPath = this.sharedIndexPath(key);
      if (sharedPath) {
        try {
          entry = JSON.parse(fs.readFileSync(sharedPath, "utf8")) as StoredIndex;
        } catch {
          // Shared indexes are derived data; absence/corruption is a miss.
        }
      }
    }
    if (!entry) return null;
    try {
      if (!validIndexIdentity(entry.identity) || !sameIdentity(entry.identity, identity))
        return null;
      if (entry.digest !== sha256Canonical({ key, identity: entry.identity, index: entry.index }))
        return null;
      const index = decodeStructured(entry.index);
      if (
        !validIndex(index) ||
        index.stateHash !== identity.stateHash ||
        !sameIdentity(index.epoch, identity.epoch)
      )
        return null;
      if (authorityDependencyIndexDigest(index) !== index.digest) return null;
      const covered = new Set([...index.consumerInputs.keys(), ...index.blockingConsumers]);
      if (covered.size !== expectedConsumers.size) return null;
      for (const [unitName, expected] of expectedConsumers) {
        if (!covered.has(unitName)) return null;
        const actual = index.consumerInputs.get(unitName);
        if (
          identity.consumerSource === "analyzer-facts" &&
          actual &&
          (actual.effectiveVersion !== expected.effectiveVersion ||
            (expected.moduleClosureDigest !== undefined &&
              actual.moduleClosureDigest !== expected.moduleClosureDigest))
        )
          return null;
        if (
          identity.consumerSource === "analyzer-facts" &&
          actual &&
          !this.fact(
            {
              epoch: { analyzerVersion: identity.epoch.analyzerVersion },
              unitName,
              effectiveVersion: actual.effectiveVersion,
              moduleClosureDigest: actual.moduleClosureDigest,
            },
            validation
          )
        )
          return null;
      }
      return index;
    } catch {
      return null;
    }
  }

  indexDetailed(
    identity: AuthorityIndexIdentity,
    expectedConsumers: ReadonlyMap<
      string,
      { effectiveVersion: string; moduleClosureDigest?: string }
    >,
    validation = this.validation()
  ): AuthorityIndexCacheLookup {
    this.load();
    const key = indexKey(identity);
    const local = this.indexes.some((candidate) => candidate.key === key);
    const sharedPath = this.sharedIndexPath(key);
    const shared = sharedPath ? fs.existsSync(sharedPath) : false;
    const index = this.index(identity, expectedConsumers, validation);
    return index
      ? { index, source: local ? "local" : "shared", reason: "hit" }
      : { index: null, source: null, reason: local || shared ? "invalid" : "missing" };
  }

  commit(
    identity: AuthorityIndexIdentity,
    index: AuthorityDependencyIndex,
    facts: readonly CachedAuthorityFacts[]
  ): void {
    this.load();
    if (
      !index.complete ||
      index.blockingConsumers.size > 0 ||
      index.stateHash !== identity.stateHash
    ) {
      throw new Error("Cannot persist an incomplete or mismatched authority index");
    }
    const nextFacts = [...this.facts];
    for (const fact of facts) {
      const key = factKey(fact.identity);
      const encoded = encodeStructured(fact.facts);
      const entry: StoredFact = {
        key,
        identity: fact.identity,
        dependencies: [...fact.dependencies],
        facts: encoded,
        digest: sha256Canonical({
          key,
          identity: fact.identity,
          dependencies: fact.dependencies,
          facts: encoded,
        }),
      };
      this.recordDiagnosticIdentity(fact.identity, key);
      const existing = nextFacts.findIndex((candidate) => candidate.key === key);
      if (existing >= 0) nextFacts.splice(existing, 1);
      nextFacts.push(entry);
      const sharedPath = this.sharedFactPath(key);
      if (sharedPath) {
        writeJsonFileAtomic(sharedPath, entry);
        const baseIdentity: AuthorityConsumerBaseIdentity = {
          epoch: fact.identity.epoch,
          unitName: fact.identity.unitName,
          effectiveVersion: fact.identity.effectiveVersion,
        };
        const candidate: StoredFactCandidate = {
          baseIdentity,
          factKey: key,
          digest: sha256Canonical({ baseIdentity, factKey: key }),
        };
        const candidatePath = this.sharedCandidatePath(factBaseKey(baseIdentity));
        if (candidatePath) writeJsonFileAtomic(candidatePath, candidate);
      }
    }
    const key = indexKey(identity);
    const encodedIndex = encodeStructured(index);
    const storedIndex: StoredIndex = {
      key,
      identity,
      index: encodedIndex,
      digest: sha256Canonical({ key, identity, index: encodedIndex }),
    };
    const sharedIndexPath = this.sharedIndexPath(key);
    if (sharedIndexPath) writeJsonFileAtomic(sharedIndexPath, storedIndex);
    const nextIndexes = this.indexes.filter((entry) => entry.key !== key);
    nextIndexes.push(storedIndex);
    const next: CacheFile = {
      version: CACHE_VERSION,
      facts: trimNewest(nextFacts, MAX_FACTS),
      indexes: trimNewest(nextIndexes, MAX_INDEXES),
    };
    writeJsonFileAtomic(this.filePath, next);
    this.facts = next.facts;
    this.indexes = next.indexes;
    this.pruneSharedStoreIfDue();
  }
}

import * as path from "node:path";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import { getUserDataPath } from "@vibestudio/env-paths";
import { sha256Canonical } from "@vibestudio/shared/authority/invocationSnapshot";
import { writeJsonFileAtomic } from "../hostCore/atomicFile.js";
import {
  authorityDependencyIndexDigest,
  type AuthorityAnalysisEpoch,
  type AuthorityDependencyIndex,
} from "./authorityDependencyIndex.js";
import type { WorkspaceServiceCallFact } from "./userlandAuthorityAnalyzer.js";

const CACHE_VERSION = 2 as const;
const MAX_FACTS = 256;
const MAX_INDEXES = 8;

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface AuthorityIndexIdentity {
  stateHash: string;
  epoch: AuthorityAnalysisEpoch;
  environmentDigest: string;
  graphDigest: string;
}

export interface AuthorityConsumerIdentity {
  epoch: AuthorityAnalysisEpoch;
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

function validConsumerIdentity(value: unknown): value is AuthorityConsumerIdentity {
  if (!value || typeof value !== "object") return false;
  const identity = value as Record<string, unknown>;
  return (
    validEpoch(identity["epoch"]) &&
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

function validIndexIdentity(value: unknown): value is AuthorityIndexIdentity {
  if (!value || typeof value !== "object") return false;
  const identity = value as Record<string, unknown>;
  return (
    typeof identity["stateHash"] === "string" &&
    validEpoch(identity["epoch"]) &&
    typeof identity["environmentDigest"] === "string" &&
    typeof identity["graphDigest"] === "string"
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

export function authorityModuleClosureDigest(input: {
  epoch: AuthorityAnalysisEpoch;
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

  constructor(
    private readonly filePath: string,
    private readonly sharedFactsDir?: string
  ) {}

  static forWorkspace(workspaceId: string): AuthorityAnalysisCache {
    const workspaceKey = sha256Canonical({ workspaceId });
    const cacheRoot = path.join(getUserDataPath(), "authority-analysis");
    return new AuthorityAnalysisCache(
      path.join(cacheRoot, `${workspaceKey}.json`),
      path.join(cacheRoot, "facts")
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
      if (!decoded) continue;
      this.facts.splice(offset, 1);
      this.facts.push(entry);
      return decoded;
    }
    const candidatePath = this.sharedCandidatePath(factBaseKey(base));
    if (!candidatePath) return null;
    try {
      const candidate = JSON.parse(fs.readFileSync(candidatePath, "utf8")) as StoredFactCandidate;
      if (
        !candidate ||
        typeof candidate.factKey !== "string" ||
        !sameIdentity(candidate.baseIdentity, base) ||
        candidate.digest !==
          sha256Canonical({ baseIdentity: candidate.baseIdentity, factKey: candidate.factKey })
      )
        return null;
      const sharedPath = this.sharedFactPath(candidate.factKey);
      if (!sharedPath) return null;
      const entry = JSON.parse(fs.readFileSync(sharedPath, "utf8")) as StoredFact;
      if (!validConsumerIdentity(entry.identity) || !sameConsumerBase(entry.identity, base))
        return null;
      return this.decodeFactEntry(entry, candidate.factKey, entry.identity, validation);
    } catch {
      return null;
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
    const entry = this.indexes.find((candidate) => candidate.key === key);
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
          actual &&
          (actual.effectiveVersion !== expected.effectiveVersion ||
            (expected.moduleClosureDigest !== undefined &&
              actual.moduleClosureDigest !== expected.moduleClosureDigest))
        )
          return null;
        if (
          actual &&
          !this.fact(
            {
              epoch: identity.epoch,
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
  }
}

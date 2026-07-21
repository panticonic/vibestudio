import { createHash } from "node:crypto";
import { canonicalJson } from "../contentTree/canonicalJson.js";

/** Full SHA-256 values are the only executable/security identifiers. */
export type Sha256 = string & { readonly __sha256: unique symbol };

export interface SourceRevisionRef {
  repoPath: string;
  sourceEv: Sha256;
  stateHash: Sha256;
}

export type CanonicalBuildValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalBuildValue[]
  | { readonly [key: string]: CanonicalBuildValue };

export type CanonicalBuildOptions = Readonly<Record<string, CanonicalBuildValue>>;

export interface ToolchainManifestRef {
  digest: Sha256;
  components: Readonly<Record<string, Sha256>>;
}

export interface LockedDependencyGraphRef {
  digest: Sha256;
}

export interface BuildRecipe {
  target: string;
  platform: string;
  architecture: string;
  abi: string | null;
  options: CanonicalBuildOptions;
  toolchain: ToolchainManifestRef;
  dependencyGraph: LockedDependencyGraphRef;
  /** Exact builder/plugin code, separate from the tool binaries it invokes. */
  builderDigest: Sha256;
  /** Names and values of the non-secret environment admitted to the build. */
  declaredEnvironment: Readonly<Record<string, string>>;
}

export interface ExecutionArtifactRef {
  source: SourceRevisionRef;
  recipeDigest: Sha256;
  buildKey: Sha256;
  artifactDigest: Sha256;
  executionDigest: Sha256;
}

export type ExecutionSelector =
  | { kind: "head"; repoPath: string; head: "main" | { contextId: string } }
  | { kind: "state"; repoPath: string; stateHash: Sha256 }
  | { kind: "artifact"; executionDigest: Sha256 };

export type SelectorPolicy = ExecutionSelector;

export type AdoptionPolicy =
  | { kind: "next-request" }
  | { kind: "cache-invalidation" }
  | { kind: "queued-user-action"; action: string }
  | { kind: "mobile-install" }
  | { kind: "process-restart" };

export interface ArtifactManifestEntry {
  path: string;
  role: string;
  size: number;
  mode: 0o644 | 0o755;
  contentType: string;
  digest: Sha256;
}

export interface ArtifactManifest {
  version: 1;
  source: SourceRevisionRef;
  recipeDigest: Sha256;
  buildKey: Sha256;
  entries: readonly ArtifactManifestEntry[];
}

export interface ArtifactBundleEntry {
  path: string;
  role: string;
  mode: 0o644 | 0o755;
  contentType: string;
  bytes: Uint8Array;
}

const SHA256_RE = /^[0-9a-f]{64}$/;
const STATE_SHA256_RE = /^state:([0-9a-f]{64})$/;

export function sha256(value: string | Uint8Array): Sha256 {
  return createHash("sha256").update(value).digest("hex") as Sha256;
}

export function parseSha256(value: string, label = "SHA-256"): Sha256 {
  const normalized = STATE_SHA256_RE.exec(value)?.[1] ?? value;
  if (!SHA256_RE.test(normalized)) {
    throw new Error(`${label} must be a full lowercase SHA-256 digest`);
  }
  return normalized as Sha256;
}

export function displayDigest(value: Sha256, length = 12): string {
  if (!Number.isInteger(length) || length < 8 || length > 64) {
    throw new Error("Display digest length must be between 8 and 64");
  }
  return value.slice(0, length);
}

/**
 * Length framing makes domain hashes unambiguous even when values contain NULs
 * or happen to concatenate to the same bytes.
 */
export function domainHash(domain: string, ...values: readonly (string | Uint8Array)[]): Sha256 {
  if (!/^vibestudio\/[a-z0-9-]+\/v[1-9][0-9]*$/.test(domain)) {
    throw new Error(`Invalid hash domain: ${domain}`);
  }
  const hash = createHash("sha256");
  const updateFrame = (value: string | Uint8Array): void => {
    const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
    const length = Buffer.allocUnsafe(8);
    length.writeBigUInt64BE(BigInt(bytes.byteLength));
    hash.update(length);
    hash.update(bytes);
  };
  updateFrame(domain);
  for (const value of values) updateFrame(value);
  return hash.digest("hex") as Sha256;
}

export function canonicalArtifactPath(input: string): string {
  const normalized = input.replace(/\\/g, "/").normalize("NFC");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.includes("\0")
  ) {
    throw new Error(`Artifact path must be relative: ${JSON.stringify(input)}`);
  }
  const parts = normalized.split("/");
  if (parts.some((part) => part.length === 0 || part === "." || part === "..")) {
    throw new Error(`Artifact path is not canonical: ${JSON.stringify(input)}`);
  }
  return parts.join("/");
}

export function canonicalBuildRecipe(recipe: BuildRecipe): string {
  assertCanonicalValue(recipe.options, "recipe.options");
  for (const [name, value] of Object.entries(recipe.declaredEnvironment)) {
    if (!name || name.includes("\0") || typeof value !== "string") {
      throw new Error(`Invalid declared environment entry: ${JSON.stringify(name)}`);
    }
  }
  const components = Object.fromEntries(
    Object.entries(recipe.toolchain.components)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, digest]) => [name, parseSha256(digest, `toolchain component ${name}`)])
  );
  return canonicalJson({
    version: 1,
    target: recipe.target,
    platform: recipe.platform,
    architecture: recipe.architecture,
    abi: recipe.abi,
    options: recipe.options,
    toolchain: {
      digest: parseSha256(recipe.toolchain.digest, "toolchain digest"),
      components,
    },
    dependencyGraph: {
      digest: parseSha256(recipe.dependencyGraph.digest, "dependency graph digest"),
    },
    builderDigest: parseSha256(recipe.builderDigest, "builder digest"),
    declaredEnvironment: recipe.declaredEnvironment,
  });
}

export function computeRecipeDigest(recipe: BuildRecipe): Sha256 {
  return domainHash("vibestudio/build-recipe/v1", canonicalBuildRecipe(recipe));
}

export function computeSourceEv(input: {
  repoPath: string;
  stateHash: string;
  closure: readonly { repoPath: string; stateHash: string }[];
}): Sha256 {
  const closure = input.closure
    .map((entry) => ({
      repoPath: canonicalRepoPath(entry.repoPath),
      stateHash: parseSha256(entry.stateHash, `state hash for ${entry.repoPath}`),
    }))
    .sort((a, b) => a.repoPath.localeCompare(b.repoPath));
  return domainHash(
    "vibestudio/source-closure/v1",
    canonicalJson({
      version: 1,
      repoPath: canonicalRepoPath(input.repoPath),
      stateHash: parseSha256(input.stateHash, "source state hash"),
      closure,
    })
  );
}

export function createSourceRevision(input: {
  repoPath: string;
  stateHash: string;
  /** Precomputed canonical source/dependency-closure digest, when the source
   * system already owns that computation. */
  sourceEv?: string;
  closure?: readonly { repoPath: string; stateHash: string }[];
}): SourceRevisionRef {
  const repoPath = canonicalRepoPath(input.repoPath);
  const stateHash = parseSha256(input.stateHash, "source state hash");
  return {
    repoPath,
    stateHash,
    sourceEv: input.sourceEv
      ? parseSha256(input.sourceEv, "source EV")
      : computeSourceEv({
          repoPath,
          stateHash,
          closure: input.closure ?? [{ repoPath, stateHash }],
        }),
  };
}

export function computeBuildKey(source: SourceRevisionRef, recipeDigest: Sha256): Sha256 {
  return domainHash(
    "vibestudio/build-input/v1",
    canonicalJson(canonicalSource(source)),
    parseSha256(recipeDigest, "recipe digest")
  );
}

export function createArtifactManifest(input: {
  source: SourceRevisionRef;
  recipeDigest: Sha256;
  entries: readonly ArtifactBundleEntry[];
}): { manifest: ArtifactManifest; artifactDigest: Sha256 } {
  const recipeDigest = parseSha256(input.recipeDigest, "recipe digest");
  const buildKey = computeBuildKey(input.source, recipeDigest);
  const seen = new Set<string>();
  const entries = input.entries
    .map((entry) => {
      const path = canonicalArtifactPath(entry.path);
      if (seen.has(path)) throw new Error(`Duplicate artifact path: ${path}`);
      seen.add(path);
      if (entry.mode !== 0o644 && entry.mode !== 0o755) {
        throw new Error(`Unsupported artifact mode for ${path}: ${entry.mode}`);
      }
      return {
        path,
        role: canonicalArtifactRole(entry.role),
        size: entry.bytes.byteLength,
        mode: entry.mode,
        contentType: entry.contentType,
        digest: sha256(entry.bytes),
        bytes: entry.bytes,
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
  const manifest: ArtifactManifest = {
    version: 1,
    source: canonicalSource(input.source),
    recipeDigest,
    buildKey,
    entries: entries.map(({ bytes: _bytes, ...entry }) => entry),
  };
  const manifestBytes = canonicalJson(manifest);
  const artifactDigest = domainHash(
    "vibestudio/artifact-bundle/v1",
    manifestBytes,
    ...entries.flatMap((entry) => [entry.path, entry.bytes] as const)
  );
  return { manifest, artifactDigest };
}

export function createExecutionArtifactRef(input: {
  source: SourceRevisionRef;
  recipe: BuildRecipe;
  entries: readonly ArtifactBundleEntry[];
}): { ref: ExecutionArtifactRef; manifest: ArtifactManifest } {
  const recipeDigest = computeRecipeDigest(input.recipe);
  const { manifest, artifactDigest } = createArtifactManifest({
    source: input.source,
    recipeDigest,
    entries: input.entries,
  });
  const executionDigest = domainHash(
    "vibestudio/execution/v1",
    canonicalJson(canonicalSource(input.source)),
    recipeDigest,
    manifest.buildKey,
    artifactDigest
  );
  return {
    ref: {
      source: canonicalSource(input.source),
      recipeDigest,
      buildKey: manifest.buildKey,
      artifactDigest,
      executionDigest,
    },
    manifest,
  };
}

export function codePrincipal(ref: ExecutionArtifactRef): string {
  verifyExecutionArtifactRef(ref);
  return `code:${ref.source.repoPath}@${ref.executionDigest}`;
}

export function verifyExecutionArtifactRef(ref: ExecutionArtifactRef): void {
  canonicalRepoPath(ref.source.repoPath);
  parseSha256(ref.source.sourceEv, "source EV");
  parseSha256(ref.source.stateHash, "state hash");
  parseSha256(ref.recipeDigest, "recipe digest");
  const expectedBuildKey = computeBuildKey(ref.source, ref.recipeDigest);
  if (ref.buildKey !== expectedBuildKey) {
    throw new Error(`Execution artifact build key mismatch: expected ${expectedBuildKey}`);
  }
  parseSha256(ref.artifactDigest, "artifact digest");
  const expectedExecution = domainHash(
    "vibestudio/execution/v1",
    canonicalJson(canonicalSource(ref.source)),
    ref.recipeDigest,
    ref.buildKey,
    ref.artifactDigest
  );
  if (ref.executionDigest !== expectedExecution) {
    throw new Error(`Execution digest mismatch: expected ${expectedExecution}`);
  }
}

function canonicalRepoPath(input: string): string {
  const value = input.replace(/\\/g, "/").normalize("NFC");
  if (!value || value.startsWith("/") || value.includes("\0")) {
    throw new Error(`Invalid repository path: ${JSON.stringify(input)}`);
  }
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`Invalid repository path: ${JSON.stringify(input)}`);
  }
  return value;
}

function canonicalArtifactRole(input: string): string {
  if (!/^[a-z][a-z0-9-]*$/.test(input)) {
    throw new Error(`Invalid artifact role: ${JSON.stringify(input)}`);
  }
  return input;
}

function canonicalSource(source: SourceRevisionRef): SourceRevisionRef {
  return {
    repoPath: canonicalRepoPath(source.repoPath),
    sourceEv: parseSha256(source.sourceEv, "source EV"),
    stateHash: parseSha256(source.stateHash, "state hash"),
  };
}

function assertCanonicalValue(value: CanonicalBuildValue, path: string): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Object.is(value, -0)) {
      throw new Error(`${path} contains a non-canonical number`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertCanonicalValue(child, `${path}[${index}]`));
    return;
  }
  if (typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (child === undefined) throw new Error(`${path}.${key} is undefined`);
      assertCanonicalValue(child as CanonicalBuildValue, `${path}.${key}`);
    }
    return;
  }
  throw new Error(`${path} contains an unsupported value`);
}


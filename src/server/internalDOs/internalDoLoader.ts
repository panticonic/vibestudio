import * as fs from "node:fs";
import { parseDurableWorkReady, type DurableWorkQueue } from "@vibestudio/shared/durableWork";
import * as path from "node:path";
import { resolveRequiredHostArtifactRoot } from "../appRoot.js";
import { canonicalJson } from "@vibestudio/content-addressing";
import { domainHash, parseSha256 } from "@vibestudio/shared/execution/identity";
import {
  RUNTIME_APP_FILE,
  readPublishedRuntimeApp,
  type PublishedRuntimeApp,
} from "../../../scripts/lib/runtime-app.mjs";
import {
  executionArtifactDigest,
  executionSourceClosureDigest,
  verifyExecutionArtifactRef,
  type ExecutionArtifactRefV1,
} from "@vibestudio/shared/execution/retention";
import {
  parseUnitAuthorityManifest,
  type UnitAuthorityManifest,
} from "@vibestudio/shared/authorityManifest";
import executionCatalog from "./internalDoExecutionCatalog.json";
import {
  INTERNAL_DO_CLASSES,
  productBuiltinByIdentity,
  type InternalDOClassName,
} from "@vibestudio/shared/productBuiltinCatalog.generated";

export const INTERNAL_DO_SOURCE = "vibestudio/internal";
export { INTERNAL_DO_CLASSES };
export const INTERNAL_DO_PRODUCT_SEED_ID = "product:vibestudio-internal-do";

/** One product class inside the runtime application. Every class shares the
 * application's exact bytes; its execution identity binds the class name. */
export interface InternalDOProgram {
  readonly buildKey: string;
  readonly identity: InternalDOExecutionIdentity;
}

export interface InternalDOExecutionIdentity {
  source: typeof INTERNAL_DO_SOURCE;
  unitName: string;
  stateHash: string;
  buildKey: string;
  effectiveVersion: string;
  executionDigest: string;
  artifact: ExecutionArtifactRefV1;
  authority: UnitAuthorityManifest;
  durableWorkQueues: readonly DurableWorkQueue[];
}

declare global {
  var __VIBESTUDIO_RUNTIME_APP__: unknown;
}

let cached: InternalDOPrograms | null = null;

function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    if (!Object.isFrozen(value)) Object.freeze(value);
  }
  return value;
}

/** A loader-owned capture of the runtime application, never an unchecked
 * bundle DTO. Publication owns payload proof; this host owns immutable
 * selection and class-bound identity. */
export class InternalDOPrograms {
  readonly #programs: ReadonlyMap<string, InternalDOProgram>;
  readonly #publication: PublishedRuntimeApp;

  private constructor(input: unknown) {
    this.#publication = readPublishedRuntimeApp(input);
    const buildKey = this.#publication.buildKey;
    this.#programs = new Map(
      INTERNAL_DO_CLASSES.map((className) => [
        className,
        freeze({ buildKey, identity: captureExecutionIdentity(buildKey, className) }),
      ])
    );
    Object.freeze(this);
  }

  static readInstalled(): InternalDOPrograms {
    const snapshot = process.env["VIBESTUDIO_RUNTIME_APP_PATH"];
    if (snapshot) {
      if (!path.isAbsolute(snapshot))
        throw new Error("VIBESTUDIO_RUNTIME_APP_PATH must be absolute");
      return new InternalDOPrograms(JSON.parse(fs.readFileSync(snapshot, "utf8")));
    }
    if (globalThis.__VIBESTUDIO_RUNTIME_APP__ !== undefined)
      return new InternalDOPrograms(globalThis.__VIBESTUDIO_RUNTIME_APP__);
    return new InternalDOPrograms(
      JSON.parse(
        fs.readFileSync(path.join(resolveRequiredHostArtifactRoot(), RUNTIME_APP_FILE), "utf8")
      )
    );
  }

  /** The exact module the workspace's runtime node deploys. */
  app(): { readonly bundle: string; readonly buildKey: string } {
    return this.#publication;
  }

  get(className: string): InternalDOProgram {
    const program = this.#programs.get(className);
    if (!program)
      throw new Error(
        `Internal Durable Object class ${className} is not a reviewed product export`
      );
    return program;
  }

  publication(): PublishedRuntimeApp {
    return this.#publication;
  }
}

export function isInternalDOSource(source: string): boolean {
  return source === INTERNAL_DO_SOURCE;
}

export function getInternalDOPrograms(): InternalDOPrograms {
  if (cached) return cached;
  cached = InternalDOPrograms.readInstalled();
  return cached;
}

/**
 * Seal one product-baked internal DO entrypoint from the exact shipped bundle
 * and its reviewed authority manifest. The bundle hash identifies source
 * content; the execution digest additionally binds the selected class and its
 * request ceiling, so two exports from the same bundle cannot alias authority.
 */
export function internalDOExecutionIdentity(
  programs: InternalDOPrograms,
  className: string
): InternalDOExecutionIdentity {
  return programs.get(className).identity;
}

function captureExecutionIdentity(
  buildKey: string,
  className: string
): InternalDOExecutionIdentity {
  if (!(INTERNAL_DO_CLASSES as readonly string[]).includes(className)) {
    throw new Error(`Internal Durable Object class ${className} is not a reviewed product export`);
  }
  const reviewedClassName = className as InternalDOClassName;
  const artifactDigest = parseSha256(buildKey, "internal DO program build key");
  const rawManifest = executionCatalog.classes[reviewedClassName];
  const builtin = productBuiltinByIdentity(INTERNAL_DO_SOURCE, reviewedClassName);
  if (!builtin) throw new Error(`Internal Durable Object ${className} is not cataloged`);
  const durableWorkQueues = parseDurableWorkReady(rawManifest.durableWorkQueues);
  if (canonicalJson(durableWorkQueues) !== canonicalJson(builtin.durableWorkQueues))
    throw new Error(
      `Internal Durable Object ${className} queue catalog does not match its executable declaration`
    );
  const authority = parseUnitAuthorityManifest(
    {
      requests: rawManifest.requests,
      provides: rawManifest.provides,
    },
    `internal Durable Object ${className} authority`
  );
  const effectiveVersion = domainHash(
    "vibestudio/internal-do-source/v1",
    canonicalJson({ version: 1, source: INTERNAL_DO_SOURCE, artifactDigest })
  );
  const recipeDigest = domainHash(
    "vibestudio/internal-do-recipe/v1",
    canonicalJson({
      version: 1,
      source: INTERNAL_DO_SOURCE,
      className,
      builtin,
      authority,
    })
  );
  const stateHash = `state:${artifactDigest}`;
  const contentRoots = [{ repoPath: null, stateHash }] as const;
  const unsignedArtifact: Omit<ExecutionArtifactRefV1, "executionDigest"> = {
    version: 1,
    sourceState: {
      kind: "product-seed",
      workspaceId: INTERNAL_DO_PRODUCT_SEED_ID,
      effectiveVersion,
      state: null,
      contentRoots,
      sourceClosureDigest: executionSourceClosureDigest(contentRoots),
    },
    recipeDigest,
    buildKey: artifactDigest,
    artifactDigest,
  };
  const artifact = verifyExecutionArtifactRef({
    ...unsignedArtifact,
    executionDigest: executionArtifactDigest(unsignedArtifact),
  });
  return Object.freeze({
    source: INTERNAL_DO_SOURCE,
    unitName: `@panticonic/builtin/${builtin.name}`,
    stateHash,
    buildKey: artifact.buildKey,
    effectiveVersion: artifact.sourceState.effectiveVersion,
    executionDigest: artifact.executionDigest,
    artifact,
    authority,
    durableWorkQueues: Object.freeze(durableWorkQueues),
  });
}

export function internalDOExecutionArtifacts(
  programs: InternalDOPrograms
): readonly ExecutionArtifactRefV1[] {
  return INTERNAL_DO_CLASSES.map(
    (className) => internalDOExecutionIdentity(programs, className).artifact
  );
}

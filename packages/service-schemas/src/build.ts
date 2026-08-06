/**
 * Wire schema for the server "build" service. Single source of truth for the
 * service's method table — the server attaches handlers to these schemas and
 * clients derive their call types from them.
 */

import { z } from "zod";
import type { MethodAccessDescriptor } from "@vibestudio/shared/serviceAuthority";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";
import type { CapabilityScope } from "@vibestudio/rpc";
import type {
  UnitAuthorityManifest,
  UnitAuthorityRequest,
  UserlandCapabilityDefinition,
} from "@vibestudio/shared/authorityManifest";
import type { ExecutionArtifactRefV1 } from "@vibestudio/shared/execution/retention";
import type { Sha256 } from "@vibestudio/shared/execution/identity";
import { AuthorityResourceScopeSchema, authorityRowSchema } from "./authority.js";

export { AuthorityResourceScopeSchema } from "./authority.js";

export const CapabilityScopeSchema = z
  .object({
    capability: z.string().min(1),
    resource: AuthorityResourceScopeSchema,
  })
  .strict() satisfies z.ZodType<CapabilityScope>;

/** Immutable, reviewed request metadata embedded in an executable artifact. */
export const UnitAuthorityRequestSchema = CapabilityScopeSchema.extend({
  tier: z.enum(["gated", "critical"]),
  evidence: z.enum(["exact", "bounded-dynamic", "intentional-broad"]),
  packages: z.array(z.string().min(1)).readonly().optional(),
}).strict() satisfies z.ZodType<UnitAuthorityRequest>;

export const UserlandCapabilityDefinitionSchema = z
  .object({
    name: z.string(),
    title: z.string(),
    action: z.string(),
    description: z.string().optional(),
    tier: z.enum(["gated", "critical"]),
    sensitivity: z.enum(["read", "write", "admin", "destructive"]),
    resourceType: z.string(),
    presentation: z
      .object({
        domain: z.enum([
          "files",
          "web",
          "sharing",
          "accounts",
          "automation",
          "people",
          "computer",
          "safety",
        ]),
        verb: z.enum(["see", "act", "manage"]),
      })
      .strict(),
    notability: z.enum(["headline", "everyday"]),
    grantScopes: z
      .array(z.enum(["once", "task", "agent", "mission", "version", "session"]))
      .readonly(),
  })
  .strict() satisfies z.ZodType<UserlandCapabilityDefinition>;

export const UnitAuthorityManifestSchema = z
  .object({
    requests: z.array(UnitAuthorityRequestSchema).readonly(),
    provides: z.array(UserlandCapabilityDefinitionSchema).readonly(),
  })
  .strict() satisfies z.ZodType<UnitAuthorityManifest>;

// Access descriptors classify build operations; compositional authority is
// declared independently by the service and its method overrides.
const READ_ACCESS: MethodAccessDescriptor = {
  sensitivity: "read",
};
const EXTERNAL_ACQUISITION_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};
const RECOMPUTE_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};

export const buildBundleResultSchema = z
  .object({
    bundle: z.string(),
    format: z.enum(["cjs", "async-cjs"]),
    /** Present for workspace-derived bundles; absent for external npm products. */
    execution: z.lazy(() => executionArtifactRefSchema).optional(),
  })
  .strict();
export type BuildBundleResult = z.infer<typeof buildBundleResultSchema>;

export const buildArtifactSchema = z
  .object({
    path: z.string(),
    role: z.enum(["primary", "asset", "html", "css", "map", "wasm"]),
    contentType: z.string(),
    encoding: z.enum(["utf8", "base64"]),
    platform: z.string().optional(),
    integrity: z.string().optional(),
    content: z.string(),
  })
  .strict();

const panelBundlePayloadReportSchema = z
  .object({
    requests: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative(),
    jsBytes: z.number().int().nonnegative(),
    cssBytes: z.number().int().nonnegative(),
  })
  .strict();

const panelBundleReportSchema = z
  .object({
    version: z.literal(2),
    mode: z.literal("report-only"),
    entryOutput: z.string(),
    initialArtifacts: z.array(z.string()),
    initial: panelBundlePayloadReportSchema,
    lazy: panelBundlePayloadReportSchema,
    total: panelBundlePayloadReportSchema,
    largestJsChunkBytes: z.number().int().nonnegative(),
    largestInitialInputs: z.array(
      z.object({ source: z.string(), bytes: z.number().int().nonnegative() }).strict()
    ),
    largestLazyInputs: z.array(
      z.object({ source: z.string(), bytes: z.number().int().nonnegative() }).strict()
    ),
  })
  .strict();

const workspaceRpcEffectResourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("receiver-object") }).strict(),
  z.object({ kind: z.literal("opaque-handle"), argument: z.number().int().nonnegative() }).strict(),
]);

const workspaceRpcMethodDocSchema = z
  .object({
    className: z.string(),
    name: z.string(),
    signature: z.string(),
    description: z.string().optional(),
    effect: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("open") }).strict(),
      z
        .object({
          kind: z.literal("userland-capability"),
          capability: z.string(),
          resource: workspaceRpcEffectResourceSchema,
        })
        .strict(),
      z
        .object({
          kind: z.literal("host-capability"),
          capability: z.string(),
          resource: z.object({ kind: z.literal("receiver-object") }).strict(),
        })
        .strict(),
    ]),
    access: z
      .object({
        principals: z.array(z.string()).optional(),
        tier: z.enum(["open", "gated", "critical"]).optional(),
        sensitivity: z.enum(["read", "write", "admin", "destructive"]).optional(),
        codeOnly: z.boolean().optional(),
      })
      .strict()
      .optional(),
    inputContractDigest: z.string(),
    producesHandle: z
      .object({
        localName: z.string(),
        canonicalCapability: z.string(),
        definitionDigest: z.string(),
        resourceType: z.string(),
      })
      .strict()
      .optional(),
    userlandCapability: z
      .object({
        localName: z.string(),
        canonicalCapability: z.string(),
        definitionDigest: z.string(),
        resourceType: z.string(),
        grantScopes: z.array(z.enum(["once", "task", "agent", "mission", "version", "session"])),
        title: z.string(),
        action: z.string(),
        description: z.string().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const executableModuleSchema = z
  .object({
    moduleId: z.string(),
    contentDigest: z.string(),
    package: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("first-party") }).strict(),
      z
        .object({
          kind: z.literal("workspace"),
          name: z.string(),
          effectiveVersion: z.string(),
        })
        .strict(),
      z
        .object({
          kind: z.literal("external"),
          name: z.string(),
          version: z.string(),
          packageDigest: z.string(),
        })
        .strict(),
    ]),
    format: z.enum(["ts", "tsx", "js", "jsx", "mjs", "cjs"]),
    source: z.string(),
  })
  .strict();

export const buildMetadataSchema = z
  .object({
    kind: z.enum(["panel", "package", "worker", "extension", "app", "template"]),
    name: z.string(),
    buildKey: z.string().min(1),
    sourcePath: z.string().nullable(),
    ev: z.string(),
    sourceStateHash: z.string().nullable(),
    sourceState: z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("event"), eventId: z.string().min(1) }).strict(),
        z.object({ kind: z.literal("application"), applicationId: z.string().min(1) }).strict(),
        z.object({ kind: z.literal("bootstrap-snapshot"), snapshotHash: z.string() }).strict(),
      ])
      .nullable()
      .optional(),
    execution: z.lazy(() => executionArtifactRefSchema).optional(),
    sourcemap: z.boolean(),
    framework: z.string().optional(),
    bundleReport: panelBundleReportSchema.optional(),
    sharedStyles: z
      .array(
        z
          .object({
            digest: z.string(),
            contentType: z.string(),
            url: z.string(),
          })
          .strict()
      )
      .optional(),
    authority: UnitAuthorityManifestSchema.optional(),
    executableModules: z.array(executableModuleSchema).optional(),
    stateArgsSchema: z
      .record(z.unknown())
      .optional()
      .describe("Panel state-argument schema sealed from this exact source artifact."),
    workspaceRpcCatalog: z.array(workspaceRpcMethodDocSchema).optional(),
    details: z.object({ kind: z.string() }).passthrough(),
    builtAt: z.string(),
  })
  .strict();
export type BuildMetadataWire = z.infer<typeof buildMetadataSchema>;

export const buildResultSchema = z
  .object({
    dir: z.string(),
    buildKey: z.string().min(1),
    sourceStateHash: z.string().nullable(),
    metadata: buildMetadataSchema,
    artifacts: z.array(buildArtifactSchema),
  })
  .strict()
  .superRefine((result, context) => {
    if (result.buildKey !== result.metadata.buildKey) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["buildKey"],
        message: "Build result key must match metadata.buildKey",
      });
    }
  });
export type BuildResultWire = z.infer<typeof buildResultSchema>;

export const executionSourceContentRootSchema = z
  .object({
    repoPath: z.string().nullable(),
    stateHash: z.string().regex(/^state:[0-9a-f]{64}$/u),
  })
  .strict();

const sha256Schema = z
  .string()
  .regex(/^[0-9a-f]{64}$/u)
  .transform((value): Sha256 => value as Sha256);

export const executionArtifactRefSchema = z
  .object({
    version: z.literal(1),
    sourceState: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("workspace"),
          workspaceId: z.string().min(1),
          effectiveVersion: sha256Schema,
          state: z.discriminatedUnion("kind", [
            z.object({ kind: z.literal("event"), eventId: z.string().min(1) }).strict(),
            z.object({ kind: z.literal("application"), applicationId: z.string().min(1) }).strict(),
            z
              .object({
                kind: z.literal("bootstrap-snapshot"),
                snapshotHash: z.string().regex(/^state:[0-9a-f]{64}$/u),
              })
              .strict(),
          ]),
          contentRoots: z.array(executionSourceContentRootSchema).min(1),
          sourceClosureDigest: sha256Schema,
        })
        .strict(),
      z
        .object({
          kind: z.literal("product-seed"),
          workspaceId: z.string().min(1),
          effectiveVersion: sha256Schema,
          state: z.null(),
          contentRoots: z
            .array(
              executionSourceContentRootSchema.extend({
                repoPath: z.null(),
              })
            )
            .min(1),
          sourceClosureDigest: sha256Schema,
        })
        .strict(),
    ]),
    recipeDigest: sha256Schema,
    buildKey: sha256Schema,
    artifactDigest: sha256Schema,
    executionDigest: sha256Schema,
  })
  .strict() satisfies z.ZodType<ExecutionArtifactRefV1, z.ZodTypeDef, unknown>;

export const buildChangeSetSchema = z
  .object({
    changed: z.array(z.string()),
    added: z.array(z.string()),
    removed: z.array(z.string()),
  })
  .strict();

/**
 * Structured, agent-actionable build diagnostic. Reuses the typecheck service's
 * `BaseDiagnostic` shape (position + severity) so esbuild, TypeScript, and
 * authority diagnostics are one uniform type the agent parses. `source`
 * distinguishes the producer.
 */
export const buildDiagnosticSchema = z
  .object({
    source: z.enum(["esbuild", "tsc", "authority"]),
    severity: z.enum(["error", "warning"]),
    file: z.string(),
    line: z.number().int().nonnegative(),
    column: z.number().int().nonnegative(),
    endLine: z.number().int().nonnegative().optional(),
    endColumn: z.number().int().nonnegative().optional(),
    message: z.string(),
    lineText: z.string().optional(),
    suggestion: z.string().optional(),
  })
  .strict();
export type BuildDiagnosticWire = z.infer<typeof buildDiagnosticSchema>;

/** One target inside a compact, diagnostic-first repo build report. */
export const unitBuildTargetSchema = z
  .object({
    target: z.enum(["runtime", "library:panel", "library:worker"]),
    exportPath: z.string().optional(),
    buildKey: z.string().optional(),
    diagnostics: z.array(buildDiagnosticSchema),
  })
  .strict();
export type UnitBuildTargetWire = z.infer<typeof unitBuildTargetSchema>;

/**
 * Agent-actionable report for one explicitly requested unit build.
 * Build results are observations about source content, never publication gates.
 */
export const unitBuildReportSchema = z
  .object({
    repoPath: z.string(),
    unitName: z.string().optional(),
    kind: z.string(),
    status: z.enum(["ok", "failed", "skipped"]),
    diagnostics: z.array(buildDiagnosticSchema),
    builds: z.array(unitBuildTargetSchema),
  })
  .strict();
export type UnitBuildReportWire = z.infer<typeof unitBuildReportSchema>;

export const aboutPageMetaSchema = z
  .object({
    name: z.string(),
    title: z.string(),
    description: z.string().optional(),
    hiddenInLauncher: z.boolean(),
  })
  .strict();

export const panelMetadataSchema = z
  .object({
    source: z.string(),
    title: z.string(),
    description: z.string().optional(),
    hiddenInLauncher: z.boolean(),
    stateArgs: z.unknown().optional(),
    autoArchiveWhenEmpty: z.boolean().optional(),
  })
  .strict();

const buildGraphUnitSchema = z
  .object({
    name: z.string(),
    kind: z.string(),
    relativePath: z.string(),
    path: z.string().optional(),
  })
  .passthrough();

const cachedBuildSummarySchema = z
  .object({
    key: z.string().nullable(),
    cached: z.boolean(),
    artifactCount: z.number().int().nonnegative(),
    metadata: buildMetadataSchema.nullable(),
  })
  .strict();

export const buildProvenanceSchema = z
  .object({
    source: z.string(),
    found: z.boolean(),
    ambiguous: z.boolean().optional(),
    workspaceRoot: z.string(),
    candidates: z.array(buildGraphUnitSchema).optional(),
    unit: buildGraphUnitSchema.optional(),
    effectiveVersion: z.string().nullable().optional(),
    buildKeys: z
      .object({
        sourcemap: z.string().nullable(),
        production: z.string().nullable(),
      })
      .optional(),
    cachedBuilds: z.record(cachedBuildSummarySchema).optional(),
    recentBuildEvents: z.array(z.unknown()).optional(),
  })
  .passthrough();

export const recentBuildEventSchema = z
  .object({
    type: z.enum(["build-started", "build-complete", "build-error"]),
    name: z.string(),
    relativePath: z.string().optional(),
    buildKey: z.string().optional(),
    error: z.string().optional(),
    /** Structured esbuild/tsc diagnostics for this build event (replaces the
     *  lossy `error` string when present). */
    diagnostics: z.array(buildDiagnosticSchema).optional(),
    trigger: z
      .object({
        publicationId: z.string(),
        resultHostRefsBasisDigest: z.string(),
        appliedAt: z.number().int().nonnegative(),
        workspaceStateHash: z.string(),
        changedPaths: z.array(z.string()),
        repositories: z.array(
          z
            .object({
              repoPath: z.string(),
              previousStateHash: z.string().nullable(),
              nextStateHash: z.string().nullable(),
              fileChanges: z.array(
                z
                  .object({
                    kind: z.enum(["added", "removed", "changed"]),
                    path: z.string(),
                    oldContentHash: z.string().nullable(),
                    newContentHash: z.string().nullable(),
                    oldExecutable: z.boolean().nullable(),
                    newExecutable: z.boolean().nullable(),
                  })
                  .strict()
              ),
            })
            .strict()
        ),
      })
      .strict()
      .optional(),
    timestamp: z.string(),
  })
  .strict();

/**
 * One declared executable source in the workspace build graph. This is source
 * and artifact state, not a runtime-instance record; exact live entities are
 * exposed only by runtime.supervision.
 */
export const buildUnitCatalogEntrySchema = z
  .object({
    name: z.string(),
    kind: z.enum(["panel", "worker", "extension", "app"]),
    target: z.enum(["electron", "react-native", "terminal"]).nullable(),
    capabilities: z.array(z.string()),
    source: z.string(),
    displayName: z.string(),
    isAgent: z.boolean(),
    status: z.enum(["available", "building", "ready", "approval-required", "error"]),
    effectiveVersion: z.string().nullable(),
    activeBuildKey: z.string().nullable(),
    lastError: z.string().nullable(),
    pendingApproval: z
      .object({
        kind: z.string(),
        submittedAt: z.number(),
      })
      .strict()
      .nullable(),
    authorityRows: z.array(authorityRowSchema),
  })
  .strict();
export type BuildUnitCatalogEntry = z.infer<typeof buildUnitCatalogEntrySchema>;

/**
 * Which execution environment will run a library bundle — selects the module
 * resolution conditions. `worker` covers any workerd isolate, including the eval
 * sandbox (a DO): it must NOT resolve a package's panel entry, whose top-level
 * `initRuntime()` crashes outside a panel. There is intentionally NO default —
 * every library build must state where its bundle will run, so a wrong host can't
 * be chosen silently.
 */
export const libraryBuildTargetSchema = z.enum(["panel", "worker"]);
export type LibraryBuildTarget = z.infer<typeof libraryBuildTargetSchema>;

export const buildMethods = defineServiceMethods({
  listUnits: {
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "build.read",
      rationale:
        "Read-only projection of declared workspace sources, immutable build identity, and reviewed authority",
    },
    description:
      "List declared executable source units and their build readiness. This is not a process list: use runtime.supervision.list for exact live entities.",
    args: z.tuple([]),
    returns: z.array(buildUnitCatalogEntrySchema),
    access: READ_ACCESS,
  },
  getBuild: {
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "build.read",
      rationale:
        "Workspace-local compilation into an immutable cache; no publication, install, or external acquisition",
    },
    description:
      "Build a panel/worker/extension unit (or a library bundle) and return its artifacts. The optional ref selects the workspace state to build from: omitted = main HEAD, a head name (e.g. 'ctx:abc'), or an immutable 'state:…' hash. Results are cached by content-derived build key, so rebuilding an unchanged unit reuses the cache.",
    args: z.tuple([
      z.string().describe("Unit path or name to build (e.g. a panel source path)."),
      z
        .string()
        .optional()
        .describe(
          "Workspace state to build from: omitted = main HEAD, a head name, or a 'state:…' hash."
        ),
      z
        .object({
          library: z
            .boolean()
            .optional()
            .describe("Build a standalone library bundle instead of a panel/worker artifact set."),
          externals: z
            .array(z.string())
            .optional()
            .describe("Module specifiers to leave external (not bundled)."),
          libraryTarget: libraryBuildTargetSchema
            .optional()
            .describe(
              "Execution host for a library bundle ('panel' or 'worker'); required when library is true."
            ),
        })
        .refine((o) => !o.library || o.libraryTarget !== undefined, {
          message:
            "getBuild: a library build requires an explicit libraryTarget ('panel' or 'worker')",
        })
        .optional(),
    ]),
    returns: z.union([buildResultSchema, buildBundleResultSchema]),
    // Compilation only populates a content-addressed cache. It does not alter
    // workspace source, publish an artifact, install a dependency, or advance
    // semantic state, so read-only evals must be able to load workspace code.
    access: READ_ACCESS,
  },
  getBuildNpm: {
    capability: "workspace.dependencies.inspect",
    tier: {
      tier: "gated",
      session: "family",
      residency: "untrusted-execution",
      family: "build.read",
      rationale:
        "G5: external package acquisition is gated; installed code and explicitly approved eval sessions share the reviewed code family",
    },
    presentation: {
      title: "Inspect installed packages for an app, panel, worker, or extension",
      action: "inspect installed packages for an app, panel, worker, or extension",
      description:
        "Allows {requesterKind} to inspect installed packages for an app, panel, worker, or extension.",
      group: "workspace",
      authorityCategory: {
        domain: "automation",
        verb: "see",
      },
    },
    description:
      "Build an npm package as a CJS library bundle for sandbox use, leaving the given externals unbundled.",
    args: z.tuple([
      z.string().describe("npm package specifier to bundle."),
      z
        .string()
        .describe(
          'Registry semver/range to resolve and build, e.g. "1", "1.2.3", "^1.2.3", "latest", or "*".'
        ),
      z.array(z.string()).optional().describe("Module specifiers to leave external (not bundled)."),
    ]),
    returns: buildBundleResultSchema,
    access: EXTERNAL_ACQUISITION_ACCESS,
  },
  getBuildMetadata: {
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "build.read",
      rationale: "Read-only inspection of an immutable local build record",
    },
    description:
      "Cached build metadata for an immutable build key, or null if it is not cached. Includes the unit's most recent structured build diagnostics (esbuild + tsc) when any were captured.",
    args: z.tuple([z.string()]),
    returns: buildMetadataSchema
      .extend({ diagnostics: z.array(buildDiagnosticSchema).optional() })
      .nullable(),
    access: READ_ACCESS,
  },
  getBuildReport: {
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "build.read",
      rationale:
        "Workspace-local compilation and diagnostics; no publication, install, or external acquisition",
    },
    description:
      "Explicitly build a unit (runtime, or library targets for packages) at the requested workspace state and return a compact, agent-actionable report. Read all diagnostics from report.diagnostics or target-specific diagnostics from report.builds. Artifact manifests are intentionally excluded; inspect an immutable build key separately when artifact provenance is needed. This advisory projection does not publish source, authorize publication, or advance any head.",
    args: z.tuple([
      z.string().describe("Unit name or workspace-relative path."),
      z
        .string()
        .optional()
        .describe(
          "Workspace state to build from: omitted = main HEAD, 'ctx:<contextId>' = that context's exact working head, or a 'state:…' hash."
        ),
    ]),
    returns: unitBuildReportSchema,
    examples: [
      {
        args: ["workers/example", "ctx:<contextId>"],
        returns: {
          repoPath: "workers/example",
          unitName: "@workspace-workers/example",
          kind: "worker",
          status: "failed",
          diagnostics: [
            {
              source: "esbuild",
              severity: "error",
              file: "workers/example/index.ts",
              line: 12,
              column: 4,
              message: "Example build diagnostic",
            },
          ],
          builds: [
            {
              target: "runtime",
              diagnostics: [
                {
                  source: "esbuild",
                  severity: "error",
                  file: "workers/example/index.ts",
                  line: 12,
                  column: 4,
                  message: "Example build diagnostic",
                },
              ],
            },
          ],
        },
      },
    ],
    // Like getBuild, this is an advisory projection over a content-addressed
    // compilation. Diagnostics are useful precisely in read-only inspection.
    access: READ_ACCESS,
  },
  getEffectiveVersion: {
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "build.read",
      rationale: "Read-only discovery of a content-derived local unit identity",
    },
    description:
      "Effective version (content-derived identity) of a workspace unit, or null if unknown.",
    args: z.tuple([z.string()]),
    returns: z.string().nullable(),
    access: READ_ACCESS,
  },
  inspectBuildProvenance: {
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "build.read",
      rationale: "Read-only inspection of caller-visible local build provenance",
    },
    description:
      "Resolve a workspace build unit (by name, relative path, or basename) and report its effective version, immutable build keys, and cached artifact metadata. Reports ambiguity when a basename matches multiple units.",
    args: z.tuple([z.string()]),
    returns: buildProvenanceSchema,
    access: READ_ACCESS,
  },
  listRecentBuildEvents: {
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "build.read",
      rationale: "Read-only diagnostics for workspace-local build activity",
    },
    description:
      "List recent state-triggered build lifecycle events and failures, optionally filtered by unit name or workspace-relative path.",
    args: z.tuple([z.string().optional()]),
    returns: z.array(recentBuildEventSchema),
    access: READ_ACCESS,
  },
  recompute: {
    capability: "workspace.build-cache.manage",
    tier: {
      tier: "gated",
      session: "codeOnly",
      residency: "untrusted-execution",
      family: "build.control",
      rationale:
        "G5: host infrastructure plumbing; §2 durable code identity or host approval plumbing",
    },
    presentation: {
      title: "Rebuild workspace apps, panels, workers, and extensions",
      action: "rebuild workspace apps, panels, workers, and extensions",
      description:
        "Allows {requesterKind} to rebuild workspace apps, panels, workers, and extensions.",
      group: "workspace",
      authorityCategory: {
        domain: "automation",
        verb: "act",
      },
    },
    description:
      "Rediscover the package graph, recompute every unit's effective version, rebuild any changed buildable units, and return the set of changed/added/removed units.",
    args: z.tuple([]),
    returns: buildChangeSetSchema,
    access: RECOMPUTE_ACCESS,
  },
  gc: {
    capability: "workspace.build-cache.manage",
    tier: {
      tier: "gated",
      session: "codeOnly",
      residency: "untrusted-execution",
      family: "build.control",
      rationale:
        "G5: read-only host infrastructure diagnostics; §2 durable code identity or host approval plumbing",
    },
    presentation: {
      title: "Inspect build cache retention",
      action: "inspect build cache retention",
      description:
        "Allows {requesterKind} to inspect retained and unreferenced build files without removing them.",
      group: "workspace",
      authorityCategory: {
        domain: "automation",
        verb: "act",
      },
    },
    description:
      "Inspect authoritative execution retention using host-owned roots without mutating artifacts or source content. Destructive collection is private to the coordinated host epoch.",
    args: z.tuple([]),
    returns: z
      .object({
        epoch: z.number().int().nonnegative(),
        mode: z.literal("report"),
        complete: z.boolean(),
        roots: z.number().int().nonnegative(),
        rootBuildKeys: z.array(z.string()),
        storedRootBuildKeys: z.array(z.string()),
        unresolvedAuthoritativeRootBuildKeys: z.array(z.string()),
        reachableBuilds: z.number().int().nonnegative(),
        unreferenced: z.number().int().nonnegative(),
        unreferencedBytes: z.number().int().nonnegative(),
        quarantined: z.number().int().nonnegative(),
        deleted: z.number().int().nonnegative(),
        retainedForGrace: z.number().int().nonnegative(),
        notReconstructible: z.number().int().nonnegative(),
        notReconstructibleDetails: z.array(
          z.object({ buildKey: z.string(), missing: z.array(z.string()) }).strict()
        ),
        providerFailures: z.array(
          z
            .object({
              provider: z.string(),
              error: z.string(),
            })
            .strict()
        ),
        cleanupFailures: z.array(z.object({ buildKey: z.string(), error: z.string() }).strict()),
        retainedSourceRoots: z.array(executionSourceContentRootSchema),
      })
      .strict(),
    access: READ_ACCESS,
    examples: [
      {
        args: [],
        returns: {
          epoch: 0,
          mode: "report",
          complete: true,
          roots: 0,
          rootBuildKeys: [],
          storedRootBuildKeys: [],
          unresolvedAuthoritativeRootBuildKeys: [],
          reachableBuilds: 0,
          unreferenced: 0,
          unreferencedBytes: 0,
          quarantined: 0,
          deleted: 0,
          retainedForGrace: 0,
          notReconstructible: 0,
          notReconstructibleDetails: [],
          providerFailures: [],
          cleanupFailures: [],
          retainedSourceRoots: [],
        },
      },
    ],
  },
  inspectExecution: {
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "build.read",
      rationale:
        "Read-only diagnosis of an immutable execution identity, its owners, and reconstructibility",
    },
    description:
      "Explain one immutable execution identity, its authoritative owners, and whether its artifact and source closure remain reconstructible.",
    args: z.tuple([z.string().regex(/^[0-9a-f]{64}$/u)]),
    returns: z
      .object({
        artifact: executionArtifactRefSchema.nullable(),
        roots: z.array(
          z
            .object({
              owner: z.string(),
              ownerId: z.string(),
              reason: z.string(),
            })
            .strict()
        ),
        reconstructible: z.boolean(),
        missing: z.array(z.string()),
      })
      .strict(),
    access: READ_ACCESS,
  },
  getAboutPages: {
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "build.read",
      rationale: "Read-only discovery of workspace-local launcher metadata",
    },
    description: "List available about pages for the launcher UI.",
    args: z.tuple([]),
    returns: z.array(aboutPageMetaSchema),
    access: READ_ACCESS,
  },
  hasUnit: {
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "build.read",
      rationale: "Read-only lookup in the caller-visible workspace graph",
    },
    description: "Whether a build unit with this name exists in the workspace graph.",
    args: z.tuple([z.string()]),
    returns: z.boolean(),
    access: READ_ACCESS,
  },
  getPanelMetadata: {
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "build.read",
      rationale: "Read-only discovery of workspace-local panel metadata",
    },
    description:
      "Launcher metadata for a panel unit resolved from the caller-selected exact workspace ref, or null if absent or not a panel.",
    args: z.tuple([z.string(), z.string().min(1).optional()]),
    returns: panelMetadataSchema.nullable(),
    access: READ_ACCESS,
  },
  listSkills: {
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "build.read",
      rationale: "Read-only discovery of caller-visible workspace skill packages",
    },
    description:
      "List available workspace skill packages that can be loaded via the eval imports parameter.",
    args: z.tuple([]),
    returns: z.array(
      z.object({
        name: z.string(),
        path: z.string(),
        description: z.string().optional(),
      })
    ),
    access: READ_ACCESS,
  },
});

import { z } from "zod";
import { defineServiceMethods, type MethodSchema } from "@vibestudio/shared/typedServiceClient";
import type { ServiceAuthorityPolicy } from "@vibestudio/shared/serviceAuthority";
import { executionArtifactRefSchema } from "./build.js";
import { evalEventsPageSchema, evalRunResultSchema, evalRunStatusSchema } from "./eval.js";
import { vcsStateNodeRefSchema } from "./vcs.js";

/**
 * Exact ABI between the builtin EvalDO host and the dynamically loaded
 * workspace eval engine. Bump this whenever either side's structural contract
 * changes; mismatched workspace/host checkouts must fail before executing a
 * cell instead of failing later through an absent or differently-shaped API.
 */
export const EVAL_ENGINE_HOST_CONTRACT_VERSION = 1 as const;

const hostOnly: ServiceAuthorityPolicy = { principals: ["host"] };
const managed = (sensitivity: "read" | "write" | "destructive") => ({
  capability: "runtime.code-execution.manage",
  authority: hostOnly,
  tier: {
    tier: "gated" as const,
    session: "family" as const,
    rationale: "Host-only control of one product-builtin evaluation kernel.",
  },
  access: { sensitivity },
});

const causalParentSchema = z
  .object({
    kind: z.literal("trajectory-invocation"),
    logId: z.string().min(1),
    head: z.string().min(1),
    invocationId: z.string().min(1),
  })
  .strict();

export const evalEngineRunArgsSchema = z
  .object({
    code: z.string().optional(),
    path: z.string().min(1).optional(),
    sourcePath: z.string().min(1).optional(),
    sourceDigest: z.string().min(1).optional(),
    sourceState: vcsStateNodeRefSchema.optional(),
    contentStateHash: z.string().min(1).optional(),
    reset: z.boolean().optional(),
    syntax: z.enum(["javascript", "typescript", "jsx", "tsx"]).optional(),
    imports: z.record(z.string()).optional(),
    contextId: z.string().min(1).optional(),
    channelId: z.string().min(1).optional(),
    agentRef: z.string().min(1).optional(),
    resultReceiverRef: z.string().min(1).optional(),
    gatewayToken: z.string().min(1),
    executionSessionNonce: z.string().min(1).optional(),
    eventSinkNonce: z.string().min(1).optional(),
    causalParent: causalParentSchema.optional(),
    agentInvocationId: z.string().min(1).optional(),
    parent: z
      .object({
        parentId: z.string().min(1),
        parentEntityId: z.string().min(1),
        parentKind: z.enum(["panel", "worker", "do"]),
      })
      .strict()
      .optional(),
    runId: z.string().min(1).optional(),
    timeoutMs: z.number().int().positive().optional(),
    readOnly: z.boolean().optional(),
    authorityManifestDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    intentDigest: z.string().min(1).optional(),
    scopeInputRevision: z.string().min(1).optional(),
    runDigest: z.string().min(1).optional(),
  })
  .strict();

const runIdSchema = z.string().min(1);
const kernelLeaseIdSchema = z.string().min(1);
const okSchema = z.object({ ok: z.boolean() }).strict();
const cancellationSchema = z.object({ ok: z.literal(true), forcedReset: z.boolean() }).strict();
const retainedRootSchema = z
  .object({
    runId: runIdSchema,
    moduleSpecifier: z.string().min(1),
    artifact: executionArtifactRefSchema,
  })
  .strict();

const rawEvalEngineMethods = defineServiceMethods({
  acquireKernelLease: {
    ...managed("write"),
    args: z.tuple([
      z
        .object({
          leaseId: kernelLeaseIdSchema,
          idleMs: z
            .number()
            .int()
            .positive()
            .max(60 * 60 * 1_000),
        })
        .strict(),
    ]),
    returns: z
      .object({
        leaseId: kernelLeaseIdSchema,
        expiresAt: z.number().int().nonnegative(),
        holderAttached: z.boolean(),
      })
      .strict(),
  },
  attachKernelLeaseHolder: {
    ...managed("write"),
    args: z.tuple([kernelLeaseIdSchema]),
    returns: z.object({ attached: z.literal(true) }).strict(),
  },
  holdKernelLease: {
    ...managed("write"),
    args: z.tuple([kernelLeaseIdSchema]),
    returns: z
      .object({
        leaseId: kernelLeaseIdSchema,
        reason: z.enum(["expired", "released", "replaced"]),
      })
      .strict(),
  },
  run: {
    ...managed("write"),
    args: z.tuple([evalEngineRunArgsSchema]),
    returns: evalRunResultSchema,
  },
  startRun: {
    ...managed("write"),
    args: z.tuple([evalEngineRunArgsSchema.extend({ runId: runIdSchema })]),
    returns: z
      .object({
        runId: runIdSchema,
        runDigest: z.string().min(1),
        scopeInputRevision: z.string().min(1),
        status: z.enum([
          "pending",
          "running",
          "cancelling",
          "done",
          "cancelled",
          "approval-route-lost",
        ]),
        existing: z.boolean(),
      })
      .strict(),
  },
  executeRun: {
    ...managed("write"),
    args: z.tuple([runIdSchema]),
    returns: evalRunResultSchema,
  },
  getRun: {
    ...managed("read"),
    args: z.tuple([runIdSchema]),
    returns: evalRunStatusSchema,
  },
  getRunEvents: {
    ...managed("read"),
    args: z.tuple([
      runIdSchema,
      z.number().int().nonnegative().optional(),
      z.number().int().positive().max(256).optional(),
    ]),
    returns: evalEventsPageSchema,
  },
  appendAuthorityEvent: {
    ...managed("write"),
    args: z.tuple([runIdSchema, z.enum(["authority-requested", "authority-decided"]), z.unknown()]),
    returns: z.void(),
  },
  failPendingRun: {
    ...managed("write"),
    args: z.tuple([runIdSchema, z.string()]),
    returns: evalRunResultSchema.nullable(),
  },
  readScopeTextPage: {
    ...managed("read"),
    args: z.tuple([
      z.string().min(1).max(512),
      z.number().int().nonnegative(),
      z
        .number()
        .int()
        .positive()
        .max(128 * 1024),
    ]),
    returns: z
      .object({
        length: z.number().int().nonnegative(),
        encoding: z.literal("utf16le-base64"),
        chunk: z.string(),
      })
      .strict(),
  },
  deleteScopeValue: {
    ...managed("destructive"),
    args: z.tuple([z.string().min(1).max(512)]),
    returns: z.object({ ok: z.boolean(), existed: z.boolean() }).strict(),
  },
  reset: {
    ...managed("destructive"),
    args: z.tuple([]),
    returns: okSchema,
  },
  dispose: {
    ...managed("destructive"),
    args: z.tuple([]),
    returns: okSchema,
  },
  retainExecutionRoot: {
    ...managed("write"),
    args: z.tuple([runIdSchema, z.string().min(1), executionArtifactRefSchema]),
    returns: z.void(),
  },
  listRetainedExecutionRoots: {
    capability: "runtime.code-execution.manage",
    authority: hostOnly,
    tier: {
      tier: "open",
      session: "family",
      rationale: "Host-only read of immutable execution roots retained by this kernel.",
    },
    access: { sensitivity: "read" },
    directEffect: { kind: "open" },
    args: z.tuple([]),
    returns: z.array(retainedRootSchema),
  },
  cancel: {
    ...managed("destructive"),
    args: z.tuple([runIdSchema]),
    returns: cancellationSchema,
  },
});

export const evalEngineMethods = Object.fromEntries(
  Object.entries(rawEvalEngineMethods).map(([name, schema]) => [
    name,
    {
      description:
        (schema as MethodSchema).description ??
        `Operate the evaluation kernel: ${name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase()}.`,
      ...schema,
    },
  ])
) as unknown as typeof rawEvalEngineMethods;

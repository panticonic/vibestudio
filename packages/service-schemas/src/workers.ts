/** Canonical discovery, resolution and exact-storage maintenance RPC contract. */
import { z } from "zod";
import type { PrincipalKind } from "@vibestudio/rpc";
import { ResolvedWorkspaceServiceSchema } from "@vibestudio/workspace-contracts/workspaceConfigSchema";
import { requirementForPrincipals } from "@vibestudio/shared/authorization";
import {
  defineServiceMethods,
  selectedPreparedAuthorityRequirement,
} from "@vibestudio/shared/typedServiceClient";
import { doTargetId } from "@vibestudio/shared/workspaceServiceRpc";

const WorkerSourceSchema = z
  .object({
    name: z.string().describe("Workspace package name."),
    source: z.string().describe('Workspace-relative worker source, e.g. "workers/my-worker".'),
    title: z.string().optional().describe("Human-readable worker title, when declared."),
    icon: z.string().optional().describe("Semantic unit icon declared by the worker manifest."),
    entry: z
      .string()
      .optional()
      .describe('Manifest entry point relative to the source directory, e.g. "worker.tsx".'),
    classes: z
      .array(z.object({ className: z.string() }).passthrough())
      .describe("Declared Durable Object classes; empty for a regular worker."),
    agent: z
      .object({
        displayName: z.string().optional(),
        description: z.string().optional(),
        defaultConfig: z.unknown().optional(),
      })
      .passthrough()
      .optional()
      .describe("Chat-agent manifest metadata, when declared."),
  })
  .strict();

export const workspaceServiceInfoSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("durable-object"),
    origin: z.enum(["product", "workspace"]),
    name: z.string(),
    title: z.string().optional(),
    action: z.string().optional(),
    description: z.string().optional(),
    presentation: z.object({ domain: z.string(), verb: z.string() }),
    protocols: z.array(z.string()),
    source: z.string(),
    docsId: z.string().optional(),
    className: z.string(),
    defaultObjectKey: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("worker"),
    origin: z.enum(["product", "workspace"]),
    name: z.string(),
    title: z.string().optional(),
    action: z.string().optional(),
    description: z.string().optional(),
    presentation: z.object({ domain: z.string(), verb: z.string() }),
    protocols: z.array(z.string()),
    source: z.string(),
    docsId: z.string(),
    routePath: z.string(),
  }),
]);
export const resolvedDurableObjectTargetSchema = z.object({
  kind: z.literal("durable-object"),
  source: z.string(),
  className: z.string(),
  objectKey: z.string(),
  targetId: z.string(),
});

const dynamicWorkspaceServiceLeaf = {
  capabilityPrefix: "workspace-service:",
  tier: "gated" as const,
  requirement: selectedPreparedAuthorityRequirement(["host", "user", "code", "session", "mission"]),
};
const preparedResolutionAuthority = (method: "resolveService" | "resolveDurableObject") => {
  const capability = `service:workers.${method}`;
  return {
    // Resolution is a prerequisite for invoking a declared workspace
    // service. Entity-bound agents/DOs must be able to reach this preparer;
    // the selected service leaf below still enforces whether that exact
    // service admits the entity principal.
    requirement: requirementForPrincipals(["user", "host", "code"], capability),
    resource: { kind: "literal" as const, key: capability },
    prepared: {
      resolver:
        method === "resolveService"
          ? "workers.resolveService.workspace-service"
          : "workers.resolveDurableObject.target",
      leaves: [dynamicWorkspaceServiceLeaf],
    },
  };
};
const ExactDurableObjectTargetSchema = z
  .object({
    source: z.string().min(1),
    className: z.string().min(1),
    objectKey: z.string().min(1),
    targetId: z.string().optional(),
  })
  .passthrough()
  .superRefine((target, ctx) => {
    if (target.targetId !== undefined && target.targetId !== doTargetId(target)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "targetId does not match the exact source/class/objectKey target",
      });
    }
  });
const storageMaintenancePolicy = {
  capability: "workers.storage.reset",
  tier: {
    tier: "critical" as const,
    session: "family" as const,
    residency: "untrusted-execution" as const,
    family: "workers.storage-maintenance",
    rationale: "Exact-target durable storage replacement is destructive and individually reviewed",
  },
  presentation: {
    title: "Replace Durable Object storage",
    action: "replace Durable Object storage",
    description: "Back up and replace the persisted storage of one exact Durable Object target.",
    group: "runtime",
    authorityCategory: { domain: "automation" as const, verb: "act" as const },
  },
  authority: { principals: ["user", "host", "code"] as PrincipalKind[] },
  access: { sensitivity: "destructive" as const },
};

export const workersMethods = defineServiceMethods({
  listSources: {
    website: {
      kind: "eligible",
      rationale:
        "Service resolution must apply the registered receiver’s website policy and authority.",
    } as const,
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "workers.read",
      rationale:
        "P-discovery: capability discovery and introspection; §2 default {code, session} family",
    },
    description:
      "List launchable worker sources with their manifest entry point and durable object classes (empty for regular workers)",
    args: z.tuple([]),
    argumentNames: [],
    returns: z.array(WorkerSourceSchema),
    access: { sensitivity: "read" as const },
  },
  listServices: {
    website: {
      kind: "eligible",
      rationale:
        "Service resolution must apply the registered receiver’s website policy and authority.",
    } as const,
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "workers.read",
      rationale:
        "P-discovery: capability discovery and introspection; §2 default {code, session} family",
    },
    description:
      "List manifest-declared workspace services visible in the caller's live context; rows include the live docs catalog id. In eval import the top-level workers API from @workspace/runtime. Inside an installed worker, call runtime.workers.listServices() on the createWorkerRuntime(env) result; never construct a worker runtime from eval.",
    args: z.tuple([]),
    argumentNames: [],
    returns: z.array(workspaceServiceInfoSchema),
    access: { sensitivity: "read" as const, crossWorkspace: true },
  },
  resolveService: {
    website: {
      kind: "eligible",
      rationale:
        "Service resolution must apply the registered receiver’s website policy and authority.",
    } as const,
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "workers.read",
      rationale:
        "P-discovery: agent sessions must resolve only the structurally exposed services in their mission envelope",
    },
    description:
      "Resolve a live workspace service by name or protocol. In eval use the top-level workers import from @workspace/runtime; inside an installed worker use runtime.workers on the createWorkerRuntime(env) result. The returned target is called through the matching top-level or worker-runtime rpc API.",
    args: z.tuple([z.string(), z.string().nullable().optional()]),
    argumentNames: ["query", "objectKey"],
    returns: ResolvedWorkspaceServiceSchema,
    access: { sensitivity: "read" as const, crossWorkspace: true },
    authority: preparedResolutionAuthority("resolveService"),
  },
  resolveDurableObject: {
    website: {
      kind: "eligible",
      rationale:
        "Service resolution must apply the registered receiver’s website policy and authority.",
    } as const,
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "workers.read",
      rationale:
        "P-discovery: agent sessions must resolve only the structurally exposed durable targets in their mission envelope",
    },
    description:
      "Resolve and activate a concrete Durable Object RPC target by source/class/key when no declared workspace service fits. The returned target is a lifecycle handle as well as an RPC address: when the caller owns a disposable object, clear any test data and pass that same target to workers.destroy(...) so its durable storage is retired.",
    args: z.tuple([z.string(), z.string(), z.string()]),
    argumentNames: ["source", "className", "objectKey"],
    returns: resolvedDurableObjectTargetSchema,
    access: { sensitivity: "read" as const },
    authority: preparedResolutionAuthority("resolveDurableObject"),
  },
  resetStorage: {
    website: {
      kind: "closed",
      reason:
        "The workerService receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations.",
    } as const,
    ...storageMaintenancePolicy,
    description:
      "Back up, integrity-check, and reset one exact disposable Durable Object storage target. Intent is required audit context; this is not an upgrade path.",
    args: z.tuple([ExactDurableObjectTargetSchema, z.string().trim().min(1).max(500)]),
    argumentNames: ["target", "intent"],
    returns: z.object({ operationId: z.string() }).strict(),
  },
  listStorageBackups: {
    website: {
      kind: "closed",
      reason:
        "The workerService receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations.",
    } as const,
    tier: {
      tier: "open",
      session: "family",
      residency: "untrusted-execution",
      family: "workers.read",
      rationale: "Backup metadata for one exact target is recovery discovery",
    },
    description: "List verified storage backups for one exact Durable Object target.",
    args: z.tuple([ExactDurableObjectTargetSchema]),
    argumentNames: ["target"],
    returns: z.array(
      z.object({ operationId: z.string(), intent: z.string(), createdAt: z.number() }).passthrough()
    ),
    authority: { principals: ["user", "host", "code", "website"] },
    access: { sensitivity: "read" },
  },
  restoreStorageBackup: {
    website: {
      kind: "closed",
      reason:
        "The workerService receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations.",
    } as const,
    ...storageMaintenancePolicy,
    description:
      "Back up the current files, verify a named backup, and restore it to the same exact Durable Object target.",
    args: z.tuple([
      ExactDurableObjectTargetSchema,
      z.string().uuid(),
      z.string().trim().min(1).max(500),
    ]),
    argumentNames: ["target", "operationId", "intent"],
    returns: z.object({ operationId: z.string() }).strict(),
  },
});

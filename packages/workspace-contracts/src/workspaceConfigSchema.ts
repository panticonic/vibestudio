import { z } from "zod";
import type {
  WorkspaceConfig,
  WorkspaceTemplateDeclaration,
  WorkspaceTemplatePin,
  WorkspaceTemplateRegistryDeclaration,
  WorkspaceCreationDescriptor,
} from "./types.js";

export type WorkspaceJsonValue =
  | null
  | boolean
  | number
  | string
  | WorkspaceJsonValue[]
  | { [key: string]: WorkspaceJsonValue };

/** Recursive JSON value used by workspace declarations without importing host wire helpers. */
export const WorkspaceJsonValueSchema: z.ZodType<WorkspaceJsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(WorkspaceJsonValueSchema),
    z.record(WorkspaceJsonValueSchema),
  ])
);

export const WorkspaceJsonObjectSchema = z.record(WorkspaceJsonValueSchema);

const WorkspaceGitRemoteDeclarationSchema = z
  .object({ url: z.string(), branch: z.string().optional() })
  .strict();

function isCanonicalWorkspaceGitRef(value: string): boolean {
  if (!value.startsWith("refs/heads/") && !value.startsWith("refs/tags/")) return false;
  if (
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.includes("..") ||
    value.includes("@{") ||
    value.includes("//") ||
    /[\u0000-\u0020\u007f~^:?*[\\]/u.test(value)
  ) {
    return false;
  }
  const prefix = value.startsWith("refs/heads/") ? "refs/heads/" : "refs/tags/";
  const components = value.slice(prefix.length).split("/");
  return components.every(
    (component) =>
      component.length > 0 &&
      component !== "." &&
      component !== ".." &&
      !component.startsWith(".") &&
      !component.endsWith(".lock")
  );
}

/** Canonical, unambiguous remote ref accepted by exact Git source pins. */
export const WorkspaceGitRefSchema = z
  .string()
  .refine(isCanonicalWorkspaceGitRef, "Expected a canonical refs/heads/* or refs/tags/* ref");

/** Complete lowercase object id supported by the current Git transport. */
export const WorkspaceGitCommitSchema = z
  .string()
  .regex(/^[0-9a-f]{40}$/u, "Expected a full lowercase Git SHA-1 object id");

/** Versioned canonical digest of an admitted Git snapshot. */
export const WorkspaceGitSnapshotSchema = z.custom<`v1-sha256:${string}`>(
  (value) => typeof value === "string" && /^v1-sha256:[0-9a-f]{64}$/u.test(value),
  "Expected a canonical v1-sha256 snapshot digest"
);

/** Portable credential requirement name; never a concrete credential id. */
export const WorkspaceLogicalCredentialNameSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/u,
    "Expected a logical credential name using letters, digits, dot, underscore, or hyphen"
  );

export const WorkspaceGitUpstreamSchema = z
  .object({
    remote: z.string(),
    branch: z.string().optional(),
    autoPush: z.boolean().optional(),
    credential: WorkspaceLogicalCredentialNameSchema.optional(),
    authorEmail: z.string().optional(),
    authorName: z.string().optional(),
  })
  .strict();

const WorkspaceSourceRefSchema = z
  .object({ source: z.string(), ref: z.string().optional() })
  .strict();

const WorkspaceTemplateDeclarationObjectSchema = z
  .object({
    url: z.string().trim().min(1),
    credential: WorkspaceLogicalCredentialNameSchema.optional(),
  })
  .strict();

export const WorkspaceTemplateDeclarationSchema: z.ZodType<WorkspaceTemplateDeclaration> =
  WorkspaceTemplateDeclarationObjectSchema;

export const WorkspaceTemplatePinSchema: z.ZodType<WorkspaceTemplatePin> =
  WorkspaceTemplateDeclarationObjectSchema.extend({
    ref: z.string().trim().min(1),
    commit: WorkspaceGitCommitSchema,
    snapshot: WorkspaceGitSnapshotSchema,
  }).strict();

export const WorkspaceTemplateRegistryDeclarationSchema: z.ZodType<WorkspaceTemplateRegistryDeclaration> =
  z
    .object({
      url: z.string().trim().min(1),
      ref: WorkspaceGitRefSchema,
      credential: WorkspaceLogicalCredentialNameSchema.optional(),
    })
    .strict();

export const WorkspaceTemplatesConfigSchema = z
  .object({
    use: z.array(WorkspaceTemplateDeclarationSchema),
    overrides: z.record(WorkspaceTemplatePinSchema).optional(),
    conflicts: z.record(z.string().trim().min(1)).optional(),
    registry: WorkspaceTemplateRegistryDeclarationSchema.optional(),
    bootstrapAdopted: WorkspaceTemplatePinSchema.optional(),
    suggestionDecisions: z
      .record(
        z
          .object({
            digest: WorkspaceGitSnapshotSchema,
            decision: z.enum(["accepted", "declined"]),
          })
          .strict()
      )
      .optional(),
  })
  .strict();

const WorkspaceServicePrincipalSchema = z.enum(["host", "user", "code", "session", "mission"]);
const WorkspaceServicePresentationSchema = z
  .object({
    domain: z.enum(["files", "sharing", "accounts", "web", "automation", "people", "computer"]),
    verb: z.enum(["see", "act", "manage"]),
    substanceKind: z.enum(["change-set", "send", "deletion", "custom"]).optional(),
  })
  .strict()
  .superRefine((presentation, ctx) => {
    if (presentation.domain === "sharing" && !presentation.substanceKind) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["substanceKind"],
        message:
          "Publishing & sending services must declare how exact operation substance is shown",
      });
    }
  });

const WorkspaceServiceSchema = z.union([
  z
    .object({
      source: z.string(),
      name: z.string(),
      title: z.string().optional(),
      action: z.string().min(1),
      description: z.string().optional(),
      presentation: WorkspaceServicePresentationSchema,
      protocols: z.array(z.string()).optional(),
      authority: z
        .object({
          principals: z.array(WorkspaceServicePrincipalSchema).min(1),
        })
        .strict(),
      durableObject: z.object({ className: z.string() }).strict(),
    })
    .strict(),
  z
    .object({
      source: z.string(),
      name: z.string(),
      title: z.string().optional(),
      action: z.string().min(1),
      description: z.string().optional(),
      presentation: WorkspaceServicePresentationSchema,
      protocols: z.array(z.string()).optional(),
      authority: z
        .object({
          principals: z.array(WorkspaceServicePrincipalSchema).min(1),
        })
        .strict(),
      worker: z.object({ routePath: z.string() }).strict(),
    })
    .strict(),
]);

const WorkspaceRecurringSchema = z
  .object({
    name: z.string(),
    target: z
      .object({ source: z.string(), className: z.string(), objectKey: z.string().optional() })
      .strict(),
    method: z.string(),
    args: z.array(WorkspaceJsonValueSchema).optional(),
    schedule: z.object({ every: z.string(), at: z.string().optional() }).strict(),
  })
  .strict();

const WorkspaceHeartbeatSchema = z
  .object({
    name: z.string(),
    target: z
      .object({ source: z.string(), className: z.string(), objectKey: z.string().optional() })
      .strict(),
    channel: z
      .object({
        mode: z.enum(["subscribed", "fixed"]).optional(),
        id: z.string().optional(),
        handle: z.string().optional(),
      })
      .strict()
      .optional(),
    schedule: z
      .object({
        every: z.string(),
        jitter: z.string().optional(),
        at: z.string().optional(),
        activeHours: z
          .object({
            start: z.string(),
            end: z.string(),
            timezone: z.string().optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
    context: z
      .object({
        mode: z.enum(["heartbeat", "full", "isolated"]).optional(),
        promptFile: z.string().optional(),
        includeWorkspacePrompt: z.boolean().optional(),
        includeSkillIndex: z.boolean().optional(),
        tokenBudget: z.number().optional(),
      })
      .strict()
      .optional(),
    behavior: z
      .object({
        skipWhenBusy: z.boolean().optional(),
        delivery: z.enum(["none", "channel", "last-contact"]).optional(),
        ackToken: z.string().optional(),
        failureBackoff: z
          .object({ base: z.string().optional(), max: z.string().optional() })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** Canonical structural contract for resolved `meta/vibestudio.yml` configuration. */
export const WorkspaceConfigSchema = z
  .object({
    id: z.string(),
    systemEpoch: z.number().int().nonnegative(),
    defaultRepo: z.string().optional(),
    git: z
      .object({
        remotes: z.record(z.record(z.record(WorkspaceGitRemoteDeclarationSchema))).optional(),
        upstreams: z.record(z.record(WorkspaceGitUpstreamSchema)).optional(),
      })
      .strict()
      .optional(),
    initPanels: z
      .array(
        z.object({ source: z.string(), stateArgs: WorkspaceJsonObjectSchema.optional() }).strict()
      )
      .optional(),
    panelRestorePolicy: z.enum(["focused", "none"]).optional(),
    defaultAgentConfig: z
      .object({
        model: z.string().optional(),
        thinkingLevel: z.string().optional(),
        approvalLevel: z.number().optional(),
      })
      .strict()
      .optional(),
    singletonObjects: z
      .array(
        z
          .object({
            source: z.string(),
            className: z.string(),
            key: z.string(),
            contextId: z.string().optional(),
          })
          .strict()
      )
      .optional(),
    services: z.array(WorkspaceServiceSchema).optional(),
    routes: z
      .array(
        z
          .object({
            source: z.string(),
            path: z.string(),
            methods: z.array(z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"])).optional(),
            durableObject: z.object({ className: z.string() }).strict().optional(),
            worker: z.boolean().optional(),
            auth: z.enum(["public", "admin-token", "caller-token"]).optional(),
            websocket: z.boolean().optional(),
          })
          .strict()
      )
      .optional(),
    extensions: z.array(WorkspaceSourceRefSchema).optional(),
    recurring: z.array(WorkspaceRecurringSchema).optional(),
    heartbeats: z.array(WorkspaceHeartbeatSchema).optional(),
    apps: z.array(WorkspaceSourceRefSchema).optional(),
    providers: z
      .object({
        evalEngine: z.object({ source: z.string() }).strict().optional(),
        evalRuntime: z.object({ source: z.string() }).strict().optional(),
        cdpClient: z.object({ source: z.string() }).strict().optional(),
        browserData: z.object({ extension: z.string() }).strict().optional(),
        gitInterop: z.object({ extension: z.string() }).strict().optional(),
        claudeCode: z.object({ extension: z.string() }).strict().optional(),
      })
      .strict()
      .optional(),
    trust: z
      .object({
        chromeApps: z.array(z.string()).optional(),
        connectionManagementApps: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    hostTargets: z
      .object({
        electron: z
          .object({ app: z.string(), requiresExtensions: z.array(z.string()).optional() })
          .strict()
          .optional(),
        "react-native": z
          .object({ app: z.string(), requiresExtensions: z.array(z.string()).optional() })
          .strict()
          .optional(),
        terminal: z
          .object({ app: z.string(), requiresExtensions: z.array(z.string()).optional() })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict() satisfies z.ZodType<WorkspaceConfig>;

const WorkspaceConfigManifestShape = WorkspaceConfigSchema.omit({ id: true });

/** Userland-authored composition source stored in `meta/templates/workspace.yml`. */
export const WorkspaceConfigTopLayerSchema = WorkspaceConfigManifestShape.extend({
  templates: WorkspaceTemplatesConfigSchema.optional(),
  disable: z.array(z.string().trim().min(1)).optional(),
}).strict();

/**
 * Sanitized template-owned layer. Template relationships are resolver input,
 * while trust/provider grants and concrete Git credentials are never accepted
 * as inherited configuration.
 */
export const WorkspaceConfigFragmentSchema = WorkspaceConfigManifestShape.omit({
  trust: true,
  providers: true,
})
  .extend({
    git: z
      .object({
        remotes: z.record(z.record(z.record(WorkspaceGitRemoteDeclarationSchema))).optional(),
        upstreams: z
          .record(
            z.record(
              WorkspaceGitUpstreamSchema.omit({
                authorEmail: true,
                authorName: true,
              })
            )
          )
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const WorkspaceTemplateLockNodeSchema = z
  .object({
    nodeId: z.string().regex(/^t-[0-9a-f]+$/),
    alias: z.string().trim().min(1),
    pin: WorkspaceTemplatePinSchema,
    parents: z.array(z.string().regex(/^t-[0-9a-f]+$/)),
    fragmentDigest: z.string().regex(/^v1-sha256:[0-9a-f]{64}$/i),
    suggestions: z
      .object({
        trust: z
          .object({
            digest: z.string().regex(/^v1-sha256:[0-9a-f]{64}$/i),
            value: z.unknown(),
          })
          .strict()
          .optional(),
        providers: z
          .object({
            digest: z.string().regex(/^v1-sha256:[0-9a-f]{64}$/i),
            value: z.unknown(),
          })
          .strict()
          .optional(),
      })
      .strict(),
  })
  .strict();

export const WorkspaceTemplateLockSchema = z
  .object({
    version: z.literal(1),
    fingerprint: z.string().regex(/^v1-sha256:[0-9a-f]{64}$/i),
    /** The normalized top-layer declaration this generated lock realizes. */
    roots: z.array(WorkspaceTemplateDeclarationSchema),
    overrides: z.record(WorkspaceTemplatePinSchema),
    conflicts: z.record(z.string().trim().min(1)),
    nodes: z.array(WorkspaceTemplateLockNodeSchema),
    repositories: z.record(
      z
        .object({
          nodeId: z.string().regex(/^t-[0-9a-f]+$/),
          subtreeDigest: z.string().regex(/^v1-sha256:[0-9a-f]{64}$/i),
        })
        .strict()
    ),
    verification: z.enum(["verified", "deferred"]),
  })
  .strict();

export const WorkspaceCreationDescriptorSchema: z.ZodType<WorkspaceCreationDescriptor> = z
  .object({
    version: z.literal(1),
    workspaceId: z.string().trim().min(1),
    rootTemplate: WorkspaceTemplatePinSchema,
  })
  .strict();

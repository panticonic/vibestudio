import { z } from "zod";
import type {
  WorkspaceConfig,
  WorkspaceTemplateDeclaration,
  WorkspaceTemplatePin,
  WorkspaceTemplateRegistryDeclaration,
  WorkspaceTemplatePresentation,
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

// A template's name and one-sentence description, as the template says them.
//
// These two strings are the only self-asserted text this system carries about a
// source, and they exist because the alternative was worse: without them the
// install header could say nothing more than a stem chopped off the repository
// URL, which is neither the name the author chose nor a sentence about what the
// thing does. They buy a readable heading, and they buy nothing else — origin
// stays the URL, which nobody gets to assert about themselves. The sanitizer
// below is therefore not defensive tidying; it is the entire reason this field
// is safe to carry at all.

/** A name has to fit a heading; a description has to fit one line beneath it. */
const TEMPLATE_NAME_MAX = 60;
const TEMPLATE_DESCRIPTION_MAX = 200;

// Every character class that can make one string look like two, or like a
// different element of the surface it lands on. Control characters and line
// separators break the single-line contract; bidi overrides and isolates
// reorder what follows them, so a name can visually swallow the URL printed
// next to it; zero-width characters hide a difference between two names that
// render identically. The interpunct is here for a specific reason: the install
// header prints `github.com/acme/news · News 1.2.0`, so a name containing one
// can forge a second field in that line.
const TEMPLATE_TEXT_FORBIDDEN = new RegExp(
  "[" +
    "\\u0000-\\u001F\\u007F-\\u009F" + // C0/C1 controls, every newline included
    "\\u00B7\\u2022\\u2027" + // interpunct and bullets: forged field separators
    "\\u200B-\\u200F\\u2028\\u2029\\u202A-\\u202E" + // zero-width, line/para, bidi
    "\\u2060-\\u2064\\u2066-\\u206F\\uFEFF" +
    "]",
  "u"
);

/**
 * The one gate every self-asserted display string passes through.
 *
 * It DROPS rather than repairs. A name that is too long, or that carries a
 * character able to impersonate another part of the surface, is not a name this
 * system can render honestly — and a truncated or partially stripped version of
 * a hostile string is still a string its author shaped. Rendering nothing costs
 * a heading; rendering something dangerous costs the meaning of every heading.
 *
 * Whitespace is collapsed first, because the difference between one space and
 * forty is layout, not content, and nobody should have to read the difference.
 */
export function sanitizeTemplateDisplayText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const collapsed = value.replace(/\s+/gu, " ").trim();
  if (collapsed.length === 0) return undefined;
  if (collapsed.length > max) return undefined;
  if (TEMPLATE_TEXT_FORBIDDEN.test(collapsed)) return undefined;
  return collapsed;
}

/**
 * Normalize a template's self-description, dropping whatever cannot be rendered
 * honestly. Never throws: a hostile name must cost the template its heading,
 * never the user's ability to install or remove the template at all.
 */
export function sanitizeTemplatePresentation(
  value: unknown
): WorkspaceTemplatePresentation | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as { name?: unknown; description?: unknown };
  const name = sanitizeTemplateDisplayText(raw.name, TEMPLATE_NAME_MAX);
  const description = sanitizeTemplateDisplayText(raw.description, TEMPLATE_DESCRIPTION_MAX);
  if (name === undefined && description === undefined) return undefined;
  return {
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
  };
}

/**
 * The manifest field. Parsing runs the sanitizer rather than validating against
 * it, so the sanitized form is the only form that ever reaches workspace state —
 * there is no path by which raw manifest text is stored and cleaned later.
 */
export const WorkspaceTemplatePresentationSchema = z
  .unknown()
  .transform((value) => sanitizeTemplatePresentation(value));

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
      notability: z.enum(["headline", "everyday"]).optional(),
      presentation: WorkspaceServicePresentationSchema,
      protocols: z.array(z.string()).optional(),
      authority: z
        .object({
          principals: z.array(WorkspaceServicePrincipalSchema).min(1),
          binding: z.enum(["consent", "declared"]).optional(),
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
      notability: z.enum(["headline", "everyday"]).optional(),
      presentation: WorkspaceServicePresentationSchema,
      protocols: z.array(z.string()).optional(),
      authority: z
        .object({
          principals: z.array(WorkspaceServicePrincipalSchema).min(1),
          binding: z.enum(["consent", "declared"]).optional(),
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
        fastMode: z.boolean().optional(),
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
  /**
   * What a template calls itself, read only out of a template's own manifest.
   *
   * It is accepted here and NOT in the sanitized fragment, because it is not
   * configuration: nothing about how the workspace runs depends on it, and
   * inheriting it would let a dependency rename the workspace that composed it.
   * The resolver lifts it into the template state node instead, where it stays attached to
   * the one pin that asserted it.
   */
  template: WorkspaceTemplatePresentationSchema.optional(),
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

const WorkspaceTemplateStateNodeSchema = z
  .object({
    nodeId: z.string().regex(/^t-[0-9a-f]+$/),
    alias: z.string().trim().min(1),
    pin: WorkspaceTemplatePinSchema,
    parents: z.array(z.string().regex(/^t-[0-9a-f]+$/)),
    /**
     * The node's self-given name and sentence, already sanitized.
     *
     * It lives in relationship state rather than in the fragment so status and
     * provenance surfaces do not need to reinterpret runtime configuration.
     */
    presentation: z
      .object({
        name: z.string().optional(),
        description: z.string().optional(),
      })
      .strict()
      .optional(),
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

export const WorkspaceTemplateStateSchema = z
  .object({
    version: z.literal(1),
    /** The normalized workspace-authored relationship declaration. */
    roots: z.array(WorkspaceTemplateDeclarationSchema),
    overrides: z.record(WorkspaceTemplatePinSchema),
    nodes: z.array(WorkspaceTemplateStateNodeSchema),
    repositories: z.record(
      z
        .object({
          contributions: z.array(
            z
              .object({
                nodeId: z.string().regex(/^t-[0-9a-f]+$/),
                subtreeDigest: z.string().regex(/^v1-sha256:[0-9a-f]{64}$/i),
              })
              .strict()
          ),
        })
        .strict()
    ),
  })
  .strict();

export const WorkspaceCreationDescriptorSchema: z.ZodType<WorkspaceCreationDescriptor> = z
  .object({
    version: z.literal(1),
    workspaceId: z.string().trim().min(1),
    rootTemplate: WorkspaceTemplatePinSchema,
  })
  .strict();

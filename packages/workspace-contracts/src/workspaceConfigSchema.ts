import { z } from "zod";
import type { WorkspaceConfig } from "./types.js";

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

const WorkspaceGitUpstreamSchema = z
  .object({
    remote: z.string(),
    branch: z.string().optional(),
    autoPush: z.boolean().optional(),
    credentialId: z.string().optional(),
    authorEmail: z.string().optional(),
    authorName: z.string().optional(),
  })
  .strict();

const WorkspaceSourceRefSchema = z
  .object({ source: z.string(), ref: z.string().optional() })
  .strict();

const WorkspaceServicePrincipalSchema = z.enum(["host", "user", "code", "session", "mission"]);
const WorkspaceServicePresentationSchema = z
  .object({
    domain: z.enum([
      "files",
      "sharing",
      "accounts",
      "web",
      "automation",
      "people",
      "computer",
    ]),
    verb: z.enum(["see", "act", "manage"]),
    substanceKind: z.enum(["change-set", "send", "deletion", "custom"]).optional(),
  })
  .strict()
  .superRefine((presentation, ctx) => {
    if (presentation.domain === "sharing" && !presentation.substanceKind) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["substanceKind"],
        message: "Publishing & sending services must declare how exact operation substance is shown",
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

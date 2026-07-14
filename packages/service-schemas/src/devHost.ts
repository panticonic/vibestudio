import { z } from "zod";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";
import type { HubPairingInvite } from "./hubControl.js";

export const devHostTargetSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("isolated-host"),
      client: z.enum(["none", "electron"]),
      persistence: z.enum(["ephemeral", "retained"]),
    })
    .strict(),
  z.object({ kind: z.literal("current-host-client"), client: z.literal("electron") }).strict(),
]);
export type DevHostTarget = z.infer<typeof devHostTargetSchema>;

export const devLaunchStateSchema = z.enum([
  "requested",
  "snapshotting",
  "awaiting-approval",
  "snapshotting-candidate",
  "awaiting-candidate-approval",
  "bootstrapping",
  "building",
  "building-candidate",
  "validating",
  "validating-candidate",
  "starting",
  "starting-candidate",
  "pairing",
  "pairing-candidate",
  "promoting",
  "promoting-candidate",
  "ready",
  "restarting",
  "retiring-old-generation",
  "candidate-failed",
  "failed",
  "stopping",
  "stopped",
]);
export type DevLaunchState = z.infer<typeof devLaunchStateSchema>;

const ownerSchema = z
  .object({ principal: z.string(), workspaceId: z.string(), contextId: z.string() })
  .strict();

export const devLaunchStatusSchema = z
  .object({
    launchId: z.string(),
    owner: ownerSchema,
    sourceRepoPath: z.literal("projects/vibestudio"),
    sourceStateHash: z.string(),
    dirtyCount: z.number().int().nonnegative(),
    executionInputHash: z.string(),
    recipeDigest: z.string(),
    activeSnapshotId: z.string().nullable(),
    candidateSourceStateHash: z.string().nullable(),
    candidateDirtyCount: z.number().int().nonnegative().nullable(),
    candidateExecutionInputHash: z.string().nullable(),
    candidateRecipeDigest: z.string().nullable(),
    candidateSnapshotId: z.string().nullable(),
    target: devHostTargetSchema,
    state: devLaunchStateSchema,
    activeHostBuildId: z.string().nullable(),
    candidateHostBuildId: z.string().nullable(),
    readinessIdentity: z
      .object({
        launchId: z.string(),
        hostBuildId: z.string(),
        serverId: z.string(),
        endpoint: z.string(),
      })
      .strict()
      .nullable(),
    childWorkspaceId: z.string().nullable(),
    childContextId: z.string().nullable(),
    clientReadinessIdentity: z
      .object({
        launchId: z.string(),
        clientBuildId: z.string(),
        profileId: z.string(),
        pid: z.number().int().positive(),
        serverId: z.string(),
        workspaceId: z.string(),
      })
      .strict()
      .nullable(),
    processIdentity: z.string().nullable(),
    restartCount: z.number().int().nonnegative(),
    startedAt: z.number(),
    updatedAt: z.number(),
    lastError: z
      .object({ phase: z.string(), code: z.string(), message: z.string(), at: z.number() })
      .strict()
      .nullable(),
  })
  .strict();
export type DevLaunchStatus = z.infer<typeof devLaunchStatusSchema>;

export const devLaunchInputSchema = z
  .object({
    contextId: z.string().optional(),
    target: devHostTargetSchema,
    idempotencyKey: z.string().min(1).max(200),
  })
  .strict();
export type DevLaunchInput = z.infer<typeof devLaunchInputSchema>;

/** Host→trusted-provider contract. Identity and paths are host-minted. */
export interface DevHostProviderLaunchInput {
  launchId: string;
  idempotencyKey: string;
  owner: DevLaunchStatus["owner"];
  sourceRepoPath: "projects/vibestudio";
  sourceStateHash: string;
  dirtyCount: number;
  target: DevHostTarget;
  snapshot: {
    snapshotId: string;
    executionInputHash: string;
    recipeDigest: string;
    sourceRoot: string;
    scratchRoot: string;
    manifestPath: string;
    createdAt: number;
  };
  executionGrant: { resource: string; authorizedAt: number };
  /** Host-minted, single-use material. Present only for current-host-client. */
  currentHostPairing?: {
    invite: HubPairingInvite;
    expectedHost: { serverId: string; workspaceId: string };
    rpcContractVersion: number;
  };
}

export type DevHostProviderRebuildInput = Omit<DevHostProviderLaunchInput, "idempotencyKey">;

export type UnapprovedLaunchInput = Omit<
  DevHostProviderLaunchInput,
  "executionGrant" | "currentHostPairing"
>;
export type UnapprovedRebuildInput = Omit<
  DevHostProviderRebuildInput,
  "executionGrant" | "currentHostPairing"
>;

const providerSnapshotSchema = z
  .object({
    snapshotId: z.string().min(1),
    executionInputHash: z.string().min(1),
    recipeDigest: z.string().min(1),
    sourceRoot: z.string().min(1),
    scratchRoot: z.string().min(1),
    manifestPath: z.string().min(1),
    createdAt: z.number(),
  })
  .strict();

const unapprovedProviderRequestSchema = z
  .object({
    launchId: z.string().min(1),
    owner: ownerSchema,
    sourceRepoPath: z.literal("projects/vibestudio"),
    sourceStateHash: z.string().min(1),
    dirtyCount: z.number().int().nonnegative(),
    target: devHostTargetSchema,
    snapshot: providerSnapshotSchema,
  })
  .strict();

/** Host→provider custody handoff before the exact-input approval may block. */
export type DevHostProviderPreparationInput =
  | { operation: "launch"; request: UnapprovedLaunchInput }
  | { operation: "rebuild"; request: UnapprovedRebuildInput };

export const devHostProviderPreparationInputSchema = z.discriminatedUnion("operation", [
  z
    .object({
      operation: z.literal("launch"),
      request: unapprovedProviderRequestSchema.extend({ idempotencyKey: z.string().min(1) }),
    })
    .strict(),
  z
    .object({ operation: z.literal("rebuild"), request: unapprovedProviderRequestSchema })
    .strict(),
]);

export type DevHostProviderPreparationResult =
  | {
      proceed: true;
      status: DevLaunchStatus;
      /** Exact provider-owned snapshot to authorize; may supersede the caller's coalesced request. */
      request: UnapprovedLaunchInput | UnapprovedRebuildInput;
    }
  | { proceed: false; status: DevLaunchStatus };

export interface DevHostProviderPreparationFailure {
  code: string;
  message: string;
  phase: "approval" | "pairing-preparation";
}

export const DEV_HOST_PROVIDER_METHOD_NAMES = [
  "prepare",
  "failPreparation",
  "launch",
  "status",
  "rebuild",
  "stop",
  "eval",
  "logs",
  "watch",
] as const;

export const devBuildResultSchema = z
  .object({
    launchId: z.string(),
    executionInputHash: z.string(),
    hostBuildId: z.string().nullable(),
    active: z.boolean(),
    state: devLaunchStateSchema,
  })
  .strict();

export const devEvalResultSchema = z
  .object({
    launchId: z.string(),
    hostBuildId: z.string(),
    sourceStateHash: z.string(),
    result: z.unknown(),
  })
  .strict();

export const devLogEntrySchema = z
  .object({
    seq: z.number().int().positive(),
    at: z.number(),
    level: z.string(),
    message: z.string(),
  })
  .strict();
export type DevLogEntry = z.infer<typeof devLogEntrySchema>;

export const devLaunchEventSchema = z
  .object({
    seq: z.number().int().positive(),
    state: devLaunchStateSchema,
    at: z.number(),
  })
  .strict();
export type DevLaunchEvent = z.infer<typeof devLaunchEventSchema>;

export const devHostMethods = defineServiceMethods({
  launch: {
    args: z.tuple([devLaunchInputSchema]),
    returns: devLaunchStatusSchema,
    description: "Build and supervise an exact projects/vibestudio context state.",
    access: { sensitivity: "destructive" },
  },
  status: {
    args: z.tuple([z.object({ launchId: z.string().optional() }).strict().optional()]),
    returns: z.array(devLaunchStatusSchema),
    description: "List only development launches owned by the verified caller.",
    access: { sensitivity: "read" },
  },
  rebuild: {
    args: z.tuple([z.object({ launchId: z.string() }).strict()]),
    returns: devBuildResultSchema,
    description: "Rebuild the same owned launch from a new exact context snapshot.",
    access: { sensitivity: "write" },
  },
  stop: {
    args: z.tuple([z.object({ launchId: z.string() }).strict()]),
    returns: z.object({ launchId: z.string(), stopped: z.boolean() }).strict(),
    description: "Stop an owned development launch and all of its managed processes.",
    access: { sensitivity: "destructive" },
  },
  eval: {
    args: z.tuple([z.object({ launchId: z.string(), code: z.string() }).strict()]),
    returns: devEvalResultSchema,
    description: "Evaluate code against the verified active generation of an owned launch.",
    access: { sensitivity: "write" },
  },
  logs: {
    args: z.tuple([z.object({ launchId: z.string(), after: z.number().optional() }).strict()]),
    returns: z.instanceof(Response),
    description: "Stream development launch logs after re-authorizing ownership.",
    access: { sensitivity: "read" },
  },
  watch: {
    args: z.tuple([z.object({ launchId: z.string(), after: z.number().optional() }).strict()]),
    returns: z.instanceof(Response),
    description: "Stream lifecycle transitions after re-authorizing ownership.",
    access: { sensitivity: "read" },
  },
});

import { z } from "zod";
import { WorkspaceTemplatePinSchema } from "./workspaceConfigSchema.js";
import type { WorkspaceTemplatePin } from "./types.js";

/**
 * Narrow host/workspace ABI for bootstrapping an exact workspace snapshot.
 *
 * This contract intentionally contains no product semantic operation names.
 * The provider may request only the typed native effects needed to prove
 * content, materialize a projection, and publish the initialized source.
 */
export interface WorkspaceSourceExactPin {
  url: string;
  ref: string;
  commit: string;
}

/** Host-private acquisition transport for one reviewed exact workspace source. */
export interface WorkspaceSource {
  pin: WorkspaceTemplatePin;
  checkout: string;
  review?: {
    presentation?: { name?: string; description?: string };
    repositories: string[];
    files: string[];
  };
}

export const WorkspaceSourceSchema: z.ZodType<WorkspaceSource> = z
  .object({
    pin: WorkspaceTemplatePinSchema,
    checkout: z.string().trim().min(1),
    review: z
      .object({
        presentation: z
          .object({ name: z.string().optional(), description: z.string().optional() })
          .strict()
          .optional(),
        repositories: z.array(z.string()),
        files: z.array(z.string()),
      })
      .strict()
      .optional(),
  })
  .strict();

export interface WorkspaceSourceSnapshotRepository {
  repoPath: string;
  subdir: string;
  snapshot: `v1-sha256:${string}`;
  /**
   * Exact content-store state for `files`. The bootstrap host publishes this
   * reconstructable tree before initialization; the semantic authority
   * independently re-derives the hash before recording it.
   */
  contentRoot: `state:${string}`;
  files: readonly {
    path: string;
    contentHash: string;
    mode: number;
  }[];
}

export interface WorkspaceSourceEffect {
  effectId: string;
  scopeKind: "context" | "workspace";
  scopeId: string;
  commandId: string;
  payloadDigest: string;
  kind: "observe-content" | "materialize-context" | "publish-main";
  payload: Record<string, unknown>;
  status: "pending";
}

export interface WorkspaceSourceEffectAcknowledgement {
  effectId: string;
  payloadDigest: string;
  receipt: Record<string, unknown>;
}

export interface WorkspaceSourceInitializationReceipt {
  commandId: string;
  pin: WorkspaceSourceExactPin;
  initializedEventId: string;
  initializedStateHash: string;
}

export type WorkspaceSourceInitializationInspection =
  | { state: "empty" }
  | {
      state: "initializing";
      commandId: string;
      pendingEffect?: WorkspaceSourceEffect;
    }
  | {
      state: "ready";
      commandId: string;
      receipt: WorkspaceSourceInitializationReceipt;
    }
  | {
      state: "failed";
      commandId: string;
      failure: { message: string; retryable: boolean };
    };

export interface InitializeExactWorkspaceSnapshotInput {
  commandId: string;
  pin: WorkspaceSourceExactPin;
  repositories: readonly WorkspaceSourceSnapshotRepository[];
  acknowledgement?: WorkspaceSourceEffectAcknowledgement;
}

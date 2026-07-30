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
  snapshot: `v1-sha256:${string}`;
}

export interface WorkspaceSourceSnapshotRepository {
  repoPath: string;
  subdir: string;
  snapshot: `v1-sha256:${string}`;
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

import type { WorkspaceAppTarget } from "./unitManifest.js";
import type { AppCapability } from "./unitManifest.js";
import type { PendingUnitBatchApproval } from "./approvals.js";
import type { CapabilityScope } from "@vibestudio/rpc";

export type HostTarget = WorkspaceAppTarget;
export type HostTargetSelectionMode = "follow-ref" | "pinned-build" | "pinned-ref";

export interface HostTargetSelection {
  workspaceId: string;
  target: HostTarget;
  source: string;
  appId: string;
  mode: HostTargetSelectionMode;
  ref?: string;
  buildKey?: string;
  updatedAt: number;
  autoSelected?: boolean;
}

export interface HostTargetSelectionInput {
  source: string;
  mode?: HostTargetSelectionMode;
  ref?: string;
  buildKey?: string;
  autoSelected?: boolean;
}

export interface HostTargetCompatibility {
  selectable: boolean;
  reasons: string[];
  recommended: boolean;
}

export interface HostTargetCandidate {
  name: string;
  source: string;
  displayName?: string;
  target: HostTarget;
  declared: boolean;
  status:
    | "not-built"
    | "pending-approval"
    | "building"
    | "available"
    | "running"
    | "stopped"
    | "error";
  activeSourceDigest?: string | null;
  activeBundleKey?: string | null;
  capabilities: string[];
  canRollback: boolean;
  previousVersions: unknown[];
  lastError?: string | null;
  lastErrorDetails?: unknown;
  compatibility: HostTargetCompatibility;
}

export type HostTargetLaunchResult =
  | {
      status: "ready";
      launched: true;
      target: HostTarget;
      source: string;
      appId: string;
      buildKey: string;
      artifactRoute?: string;
      capabilities?: AppCapability[];
      executionDigest?: string | null;
      authorityRequests?: readonly CapabilityScope[];
      adoptionPolicy?: "immediate" | "prompt" | "artifact-only";
    }
  | {
      status: "approval-required";
      launched: false;
      target: HostTarget;
      approvals: PendingUnitBatchApproval[];
    }
  | {
      status: "preparing";
      launched: false;
      target: HostTarget;
      reason: string;
      details: string[];
    }
  | {
      status: "unavailable";
      launched: false;
      target: HostTarget;
      reason: string;
      details: string[];
    };

export type HostTargetLaunchSessionStatus =
  | "starting"
  | "approval-required"
  | "preparing"
  | "ready"
  | "unavailable"
  | "denied";

export type HostTargetLaunchPhaseId =
  | "pair"
  | "review-trust"
  | "start-units"
  | "build-app"
  | "activate-target"
  | "connected";

export type HostTargetLaunchPhaseState =
  | "pending"
  | "active"
  | "complete"
  | "blocked"
  | "failed"
  | "skipped";

export interface HostTargetLaunchTimelinePhase {
  id: HostTargetLaunchPhaseId;
  label: string;
  state: HostTargetLaunchPhaseState;
  detail?: string;
}

export interface HostTargetLaunchApprovalView {
  approvalId: string;
  title: string;
  summary: string;
  chips: string[];
  units: Array<{
    name: string;
    source: string;
    capabilities: string;
    kind: string;
  }>;
}

export interface HostTargetLaunchSessionSnapshot {
  sessionId: string;
  target: HostTarget;
  status: HostTargetLaunchSessionStatus;
  currentPhase: HostTargetLaunchPhaseId;
  message: string;
  detail?: string;
  timeline: HostTargetLaunchTimelinePhase[];
  approvals: PendingUnitBatchApproval[];
  approvalViews: HostTargetLaunchApprovalView[];
  approvalsResolved: number;
  launch?: HostTargetLaunchResult;
  startedAt: number;
  updatedAt: number;
  settled: boolean;
}

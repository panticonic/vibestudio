import type {
  PendingApproval,
  PendingUnitInstallReviewApproval,
} from "@vibestudio/shared/approvals";
import { isBootstrapUnitApproval } from "@vibestudio/shared/bootstrapApprovals";
import type { HostTarget } from "@vibestudio/shared/hostTargets";
import type { WorkspaceConfig } from "@vibestudio/workspace-contracts/types";
import type { BuildUnitCatalogEntry } from "../build.js";
import type {
  RuntimeSupervisionActivationResult,
  RuntimeSupervisionDescription,
} from "../runtime.js";

export type HostLaunchResult =
  | {
      status: "ready";
      target: HostTarget;
      entity: RuntimeSupervisionDescription;
    }
  | {
      status: "approval-required";
      target: HostTarget;
      approvals: PendingUnitInstallReviewApproval[];
    }
  | {
      status: "preparing" | "unavailable";
      target: HostTarget;
      reason: string;
    };

export interface HostLaunchSelection {
  releaseId: string;
  buildKey?: string;
}

type Call = (service: string, method: string, args: unknown[]) => Promise<unknown>;

function activationResult(
  target: HostTarget,
  result: RuntimeSupervisionActivationResult
): HostLaunchResult | null {
  if (result.status === "ready") return { status: "ready", target, entity: result.entity };
  if (result.status === "preparing" || result.status === "unavailable") {
    return { status: result.status, target, reason: result.reason };
  }
  return null;
}

export class HostLaunchClient {
  constructor(private readonly call: Call) {}

  async listCandidates(target: HostTarget): Promise<BuildUnitCatalogEntry[]> {
    const units = (await this.call("build", "listUnits", [])) as BuildUnitCatalogEntry[];
    return units.filter((unit) => unit.kind === "app" && unit.target === target);
  }

  async configuredCandidate(target: HostTarget): Promise<BuildUnitCatalogEntry | null> {
    const [config, candidates] = await Promise.all([
      this.call("workspace", "getConfig", []) as Promise<WorkspaceConfig>,
      this.listCandidates(target),
    ]);
    const configured = config.hostTargets?.[target]?.app;
    if (!configured) return null;
    return (
      candidates.find((unit) => unit.name === configured || unit.source === configured) ?? null
    );
  }

  async configuredSelection(target: HostTarget): Promise<HostLaunchSelection | null> {
    const candidate = await this.configuredCandidate(target);
    return candidate ? { releaseId: candidate.name } : null;
  }

  async launch(target: HostTarget, selection?: HostLaunchSelection): Promise<HostLaunchResult> {
    const [config, units] = await Promise.all([
      this.call("workspace", "getConfig", []) as Promise<WorkspaceConfig>,
      this.call("build", "listUnits", []) as Promise<BuildUnitCatalogEntry[]>,
    ]);
    const resolved = selection ?? (await this.configuredSelection(target));
    if (!resolved) {
      return {
        status: "unavailable",
        target,
        reason: `No ${target} app is configured or selected`,
      };
    }
    const relevantSources = new Set<string>();
    for (const source of config.hostTargets?.[target]?.requiresExtensions ?? []) {
      const extension = units.find(
        (unit) => unit.kind === "extension" && (unit.name === source || unit.source === source)
      );
      if (!extension) {
        return {
          status: "unavailable",
          target,
          reason: `Required extension is not installed: ${source}`,
        };
      }
      relevantSources.add(extension.source);
      const result = (await this.call("runtime", "supervision.activate", [
        { kind: "extension", releaseId: extension.name },
      ])) as RuntimeSupervisionActivationResult;
      if (result.status === "preparing" || result.status === "unavailable") {
        return { status: result.status, target, reason: result.reason };
      }
      if (result.status === "approval-required") {
        return this.pendingResult(target, relevantSources);
      }
    }
    const app = units.find(
      (unit) =>
        unit.kind === "app" &&
        (unit.name === resolved.releaseId || unit.source === resolved.releaseId)
    );
    if (!app || app.target !== target) {
      return {
        status: "unavailable",
        target,
        reason: `Selected ${target} app is not installed: ${resolved.releaseId}`,
      };
    }
    relevantSources.add(app.source);
    if (resolved.buildKey) {
      await this.call("runtime", "supervision.rollback", [
        { kind: "app", releaseId: resolved.releaseId },
        { buildKey: resolved.buildKey },
      ]);
    } else if (
      !app.activeBuildKey &&
      app.status !== "building" &&
      app.status !== "approval-required"
    ) {
      await this.call("runtime", "supervision.prepare", [
        { kind: "app", releaseId: resolved.releaseId },
        { ref: "main" },
      ]);
    }
    const result = (await this.call("runtime", "supervision.activate", [
      { kind: "app", releaseId: resolved.releaseId },
    ])) as RuntimeSupervisionActivationResult;
    return activationResult(target, result) ?? this.pendingResult(target, relevantSources);
  }

  async resolveApprovals(
    approvals: readonly PendingUnitInstallReviewApproval[],
    decision: "once" | "deny"
  ): Promise<void> {
    if (approvals.length === 0) return;
    await this.call("shellApproval", "resolveBootstrap", [
      approvals.map((approval) => approval.approvalId),
      decision,
    ]);
  }

  async resolvePendingStartupApprovals(decision: "once" | "deny"): Promise<number> {
    const pending = (await this.call("shellApproval", "listPending", [])) as PendingApproval[];
    const approvals = pending.filter(isBootstrapUnitApproval);
    if (approvals.length > 0) {
      await this.call("shellApproval", "resolveBootstrap", [
        approvals.map((approval) => approval.approvalId),
        decision,
      ]);
    }
    return approvals.length;
  }

  private async pendingResult(
    target: HostTarget,
    relevantSources: ReadonlySet<string>
  ): Promise<HostLaunchResult> {
    const pending = (await this.call("shellApproval", "listPending", [])) as PendingApproval[];
    return {
      status: "approval-required",
      target,
      approvals: pending.filter(
        (approval): approval is PendingUnitInstallReviewApproval =>
          approval.kind === "unit-install-review" &&
          approval.parts.some((part) => relevantSources.has(part.repoPath))
      ),
    };
  }
}

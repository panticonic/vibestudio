import { formatRpcFailure } from "@vibestudio/rpc";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import type { PendingUnitInstallReviewApproval } from "@vibestudio/shared/approvals";
import { isBootstrapUnitApproval } from "@vibestudio/shared/bootstrapApprovals";
import type { HostTarget } from "@vibestudio/shared/hostTargets";
import { buildMethods } from "../build.js";
import { runtimeMethods } from "../runtime.js";
import { shellApprovalMethods } from "../shellApproval.js";
import { workspaceMethods } from "../workspace.js";
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

export interface HostLaunchProgress {
  phase: "resolve-target" | "start-units" | "prepare-app";
  state: "active" | "complete" | "blocked" | "failed";
  detail?: string;
}

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
  private readonly build: ReturnType<typeof createTypedServiceClient<typeof buildMethods>>;
  private readonly workspace: ReturnType<typeof createTypedServiceClient<typeof workspaceMethods>>;
  private readonly runtime: ReturnType<typeof createTypedServiceClient<typeof runtimeMethods>>;
  private readonly shellApproval: ReturnType<
    typeof createTypedServiceClient<typeof shellApprovalMethods>
  >;

  constructor(
    call: Call,
    private readonly onProgress?: (progress: HostLaunchProgress) => void
  ) {
    this.build = createTypedServiceClient("build", buildMethods, call);
    this.workspace = createTypedServiceClient("workspace", workspaceMethods, call);
    this.runtime = createTypedServiceClient("runtime", runtimeMethods, call);
    this.shellApproval = createTypedServiceClient("shellApproval", shellApprovalMethods, call);
  }

  async listCandidates(target: HostTarget): Promise<BuildUnitCatalogEntry[]> {
    const units = await this.build.listUnits();
    return units.filter((unit) => unit.kind === "app" && unit.target === target);
  }

  async configuredCandidate(target: HostTarget): Promise<BuildUnitCatalogEntry | null> {
    const [config, candidates] = await Promise.all([
      this.workspace.getConfig(),
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
    let phase: HostLaunchProgress["phase"] = "resolve-target";
    const report = (progress: HostLaunchProgress) => {
      phase = progress.phase;
      this.onProgress?.(progress);
    };
    try {
      report({ phase: "resolve-target", state: "active" });
      const [config, units] = await Promise.all([
        this.workspace.getConfig(),
        this.build.listUnits(),
      ]);
      const configured = config.hostTargets?.[target]?.app;
      const candidate = units.find(
        (unit) =>
          unit.kind === "app" &&
          unit.target === target &&
          (unit.name === configured || unit.source === configured)
      );
      const resolved = selection ?? (candidate ? { releaseId: candidate.name } : null);
      if (!resolved) {
        report({ phase: "resolve-target", state: "failed" });
        return {
          status: "unavailable",
          target,
          reason: `No ${target} app is configured or selected`,
        };
      }
      const app = units.find(
        (unit) =>
          unit.kind === "app" &&
          (unit.name === resolved.releaseId || unit.source === resolved.releaseId)
      );
      if (!app || app.target !== target) {
        report({ phase: "resolve-target", state: "failed" });
        return {
          status: "unavailable",
          target,
          reason: `Selected ${target} app is not installed: ${resolved.releaseId}`,
        };
      }
      report({ phase: "resolve-target", state: "complete" });
      const relevantSources = new Set<string>();
      for (const source of config.hostTargets?.[target]?.requiresExtensions ?? []) {
        const extension = units.find(
          (unit) => unit.kind === "extension" && (unit.name === source || unit.source === source)
        );
        if (!extension) {
          report({ phase: "start-units", state: "failed", detail: source });
          return {
            status: "unavailable",
            target,
            reason: `Required extension is not installed: ${source}`,
          };
        }
        relevantSources.add(extension.source);
        report({ phase: "start-units", state: "active", detail: extension.displayName });
        const result = await this.runtime.supervision.activate({
          kind: "extension",
          releaseId: extension.name,
        });
        if (result.status === "preparing" || result.status === "unavailable") {
          report({
            phase: "start-units",
            state: result.status === "preparing" ? "active" : "failed",
            detail: result.reason,
          });
          return { status: result.status, target, reason: result.reason };
        }
        if (result.status === "approval-required") {
          report({ phase: "start-units", state: "blocked" });
          return await this.pendingResult(target, relevantSources);
        }
      }
      if ((config.hostTargets?.[target]?.requiresExtensions ?? []).length > 0)
        report({ phase: "start-units", state: "complete" });
      relevantSources.add(app.source);
      report({ phase: "prepare-app", state: "active" });
      if (resolved.buildKey) {
        await this.runtime.supervision.rollback(
          { kind: "app", releaseId: resolved.releaseId },
          { buildKey: resolved.buildKey }
        );
      }
      const result = await this.runtime.supervision.activate({
        kind: "app",
        releaseId: resolved.releaseId,
      });
      report({
        phase: "prepare-app",
        state:
          result.status === "ready"
            ? "complete"
            : result.status === "approval-required"
              ? "blocked"
              : result.status === "preparing"
                ? "active"
                : "failed",
        ...(result.status === "unavailable" || result.status === "preparing"
          ? { detail: result.reason }
          : {}),
      });
      return (
        activationResult(target, result) ?? (await this.pendingResult(target, relevantSources))
      );
    } catch (error) {
      report({
        phase,
        state: "failed",
        detail: formatRpcFailure(error),
      });
      throw error;
    }
  }

  async resolveApprovals(
    approvals: readonly PendingUnitInstallReviewApproval[],
    decision: "once" | "deny"
  ): Promise<void> {
    if (approvals.length === 0) return;
    await this.shellApproval.resolveBootstrap(
      approvals.map((approval) => approval.approvalId),
      decision
    );
  }

  async resolvePendingStartupApprovals(decision: "once" | "deny"): Promise<number> {
    const pending = await this.shellApproval.listPending();
    const approvals = pending.filter(isBootstrapUnitApproval);
    if (approvals.length > 0) {
      await this.shellApproval.resolveBootstrap(
        approvals.map((approval) => approval.approvalId),
        decision
      );
    }
    return approvals.length;
  }

  private async pendingResult(
    target: HostTarget,
    relevantSources: ReadonlySet<string>
  ): Promise<HostLaunchResult> {
    const pending = await this.shellApproval.listPending();
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

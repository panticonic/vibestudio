import { hostBuildOrigin, unresolvedOrigin } from "@vibestudio/shared/authority/reviewedUnitParts";
import { templateOrigin } from "@vibestudio/origin-identity";
import type { InstallReviewOrigin } from "@vibestudio/shared/authority/unitInstallReview";
import { sanitizeTemplateDisplayText } from "@vibestudio/workspace-contracts/workspaceConfigSchema";
import type { UnitSourceOrigin } from "./unitAdmissionStore.js";

const TEMPLATE_NAME_MAX = 60;
export interface UnitOriginResolverDeps {
  recordedSourceFor?(repoPath: string): RecordedUnitSource | null;
  rootTemplatePin(): { url: string | null; ref: string | null; version: string | null } | null;
  isBootstrapRepository(repoPath: string): Promise<boolean>;
  hostBuildVersion(): string | null;
  admittedOriginKeys(): ReadonlySet<string>;
  onWarning?(message: string): void;
}
export interface RecordedUnitSource {
  url: string | null;
  version?: string | null;
  selfName?: string | null;
  isWorkspaceRoot?: boolean;
}

export class UnitOriginResolver {
  private bootstrapRepositories = new Set<string>();
  constructor(private readonly deps: UnitOriginResolverDeps) {}

  async originsFor(repoPaths: Iterable<string>): Promise<ReadonlyMap<string, InstallReviewOrigin>> {
    const unique = [...new Set(repoPaths)];
    const checks = await Promise.all(
      unique.map(
        async (repoPath) => [repoPath, await this.deps.isBootstrapRepository(repoPath)] as const
      )
    );
    for (const [repoPath, present] of checks) {
      if (present) this.bootstrapRepositories.add(repoPath);
      else this.bootstrapRepositories.delete(repoPath);
    }
    const admitted = this.deps.admittedOriginKeys();
    return new Map(unique.map((repoPath) => [repoPath, this.originFor(repoPath, admitted)]));
  }

  recordedOriginFor(repoPath: string): UnitSourceOrigin | null {
    const recorded = this.deps.recordedSourceFor?.(repoPath);
    if (!recorded?.url) return null;
    const origin = this.originFor(repoPath, new Set());
    return {
      originKey: origin.originKey,
      url: origin.url,
      version: origin.version,
      ...(origin.selfName ? { selfName: origin.selfName } : {}),
      ...(origin.isWorkspaceRoot ? { isWorkspaceRoot: true } : {}),
    };
  }

  originallyInstalledFrom(repoPath: string): string | null {
    const recorded = this.deps.recordedSourceFor?.(repoPath);
    if (!recorded?.url) return null;
    const origin = this.originFor(repoPath, new Set());
    if (origin.isHostBuild) return null;
    const name = origin.selfName ?? urlStem(origin.url) ?? origin.originKey;
    return origin.version ? `${name} ${origin.version}` : name;
  }

  private originFor(repoPath: string, admitted: ReadonlySet<string>): InstallReviewOrigin {
    const recorded = this.deps.recordedSourceFor?.(repoPath);
    if (recorded?.url) {
      const selfName = sanitizeTemplateDisplayText(recorded.selfName, TEMPLATE_NAME_MAX);
      return templateOrigin({
        url: recorded.url,
        version: recorded.version ?? null,
        ...(selfName ? { selfName } : {}),
        admittedOriginKeys: admitted,
        isWorkspaceRoot: recorded.isWorkspaceRoot === true,
      });
    }
    if (this.bootstrapRepositories.has(repoPath)) {
      const root = this.deps.rootTemplatePin();
      if (root?.url) {
        return templateOrigin({
          url: root.url,
          version: root.version ?? root.ref,
          admittedOriginKeys: admitted,
          isWorkspaceRoot: true,
        });
      }
      return hostBuildOrigin(this.deps.hostBuildVersion());
    }
    return unresolvedOrigin();
  }
}

function urlStem(url: string | null): string | null {
  if (!url) return null;
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).at(-1);
    return last?.replace(/\.git$/u, "") ?? null;
  } catch {
    return null;
  }
}

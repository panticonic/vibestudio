import type { BuildUnitCatalogEntry } from "@vibestudio/service-schemas/build";
import type { AuthorityRow } from "@vibestudio/shared/authority/authorityRows";
import type { UnitAuthorityRequest } from "@vibestudio/shared/authorityManifest";
import type { BuildSystemV2 } from "../buildV2/index.js";

export type HostedSourceStatus = {
  name: string;
  kind: "extension" | "app";
  source: string;
  status: "available" | "running" | "stopped" | "error" | "pending-approval" | "building";
  activeBundleKey: string | null;
  lastError: string | null;
  pendingApproval?: { kind: string; submittedAt: number } | null;
};

export type WorkerSourceStatus = {
  source: string;
  status: "building" | "starting" | "running" | "error" | "stopped";
  buildKey?: string | null;
};

export interface BuildUnitCatalogDeps {
  buildSystem: BuildSystemV2;
  hostedSources(): readonly HostedSourceStatus[];
  workerSources(): readonly WorkerSourceStatus[];
  workerError(source: string): { message: string } | null;
  authorityRows(requests: readonly UnitAuthorityRequest[]): AuthorityRow[];
}

function hostedBuildStatus(
  row: HostedSourceStatus | undefined,
  effectiveVersion: string | null
): BuildUnitCatalogEntry["status"] {
  if (row?.status === "pending-approval") return "approval-required";
  if (row?.status === "building") return "building";
  if (row?.status === "error") return "error";
  return row?.activeBundleKey || effectiveVersion ? "ready" : "available";
}

export function listBuildUnitCatalog(deps: BuildUnitCatalogDeps): BuildUnitCatalogEntry[] {
  const hostedBySource = new Map(deps.hostedSources().map((row) => [row.source, row]));
  const workersBySource = new Map(deps.workerSources().map((row) => [row.source, row]));

  return deps.buildSystem
    .getGraph()
    .allNodes()
    .filter(
      (
        node
      ): node is typeof node & {
        kind: "panel" | "worker" | "extension" | "app";
      } =>
        node.kind === "panel" ||
        node.kind === "worker" ||
        node.kind === "extension" ||
        node.kind === "app"
    )
    .map((node): BuildUnitCatalogEntry => {
      const effectiveVersion = deps.buildSystem.getEffectiveVersion(node.name);
      const hosted =
        node.kind === "extension" || node.kind === "app"
          ? hostedBySource.get(node.relativePath)
          : undefined;
      const worker = node.kind === "worker" ? workersBySource.get(node.relativePath) : undefined;
      const workerError = node.kind === "worker" ? deps.workerError(node.relativePath) : null;
      const status =
        node.kind === "extension" || node.kind === "app"
          ? hostedBuildStatus(hosted, effectiveVersion)
          : worker?.status === "starting" || worker?.status === "building"
            ? "building"
            : workerError
              ? "error"
              : effectiveVersion
                ? "ready"
                : "available";
      return {
        name: node.name,
        kind: node.kind,
        target: node.kind === "app" ? (node.manifest.app?.target ?? null) : null,
        capabilities: node.kind === "app" ? [...(node.manifest.app?.capabilities ?? [])] : [],
        source: node.relativePath,
        displayName: node.manifest.displayName ?? node.manifest.title ?? node.name,
        isAgent: Boolean(node.manifest.agent),
        status,
        effectiveVersion,
        activeBuildKey: hosted?.activeBundleKey ?? worker?.buildKey ?? null,
        lastError: hosted?.lastError ?? workerError?.message ?? null,
        pendingApproval: hosted?.pendingApproval ?? null,
        authorityRows: deps.authorityRows(node.manifest.authority?.requests ?? []),
      };
    })
    .sort((left, right) => left.source.localeCompare(right.source));
}

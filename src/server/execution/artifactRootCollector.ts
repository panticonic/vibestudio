import * as fs from "node:fs";
import * as path from "node:path";
import { parseSha256, type Sha256 } from "@vibestudio/shared/execution/identity";
import type { ArtifactRetentionRoot } from "./executionArtifactStore.js";
import { stateLayout } from "../stateLayout.js";

/**
 * Reads retention roots from their owning durable stores. Callers never supply
 * an "active unit" list, so artifact deletion cannot be authorized by an RPC
 * argument that omits another surface's rollback or grant root.
 */
export function collectArtifactRetentionRoots(statePath: string): ArtifactRetentionRoot[] {
  const roots: ArtifactRetentionRoot[] = [];
  const layout = stateLayout(statePath);
  const add = (kind: ArtifactRetentionRoot["kind"], id: string, executionDigest: unknown): void => {
    if (typeof executionDigest !== "string") return;
    roots.push({ kind, id, executionDigest: parseSha256(executionDigest, `${kind}:${id}`) });
  };

  const incarnations = readJson(layout.runtimeIncarnationsFile) as {
    active?: Record<string, string>;
    incarnations?: Array<{ incarnationId?: string; artifact?: { executionDigest?: string } }>;
    transitions?: Array<{ transitionId?: string; toIncarnationId?: string; status?: string }>;
  } | null;
  const byIncarnation = new Map(
    (incarnations?.incarnations ?? []).map((record) => [record.incarnationId, record] as const)
  );
  for (const [entityId, incarnationId] of Object.entries(incarnations?.active ?? {})) {
    add(
      "active-incarnation",
      entityId,
      byIncarnation.get(incarnationId)?.artifact?.executionDigest
    );
  }
  for (const transition of incarnations?.transitions ?? []) {
    if (transition.status !== "preparing" && transition.status !== "awaiting-adoption") continue;
    add(
      "upgrade-transition",
      transition.transitionId ?? "unknown-transition",
      byIncarnation.get(transition.toIncarnationId)?.artifact?.executionDigest
    );
  }

  const unitsRoot = layout.units.root;
  if (fs.existsSync(unitsRoot)) {
    for (const entry of fs
      .readdirSync(unitsRoot, { withFileTypes: true })
      .filter((candidate) => candidate.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const kind = entry.name;
      const registry = readJson(path.join(unitsRoot, kind, "registry.json")) as {
        entries?: Array<Record<string, unknown>>;
      } | null;
      for (const entry of registry?.entries ?? []) {
        const name = typeof entry["name"] === "string" ? entry["name"] : `${kind}:unknown`;
        add("app-version", `${kind}:${name}:active`, entry["activeExecutionDigest"]);
        const history = Array.isArray(entry["previousVersions"])
          ? (entry["previousVersions"] as Array<Record<string, unknown>>)
          : [];
        history.forEach((version, index) =>
          add("app-version", `${kind}:${name}:rollback:${index}`, version["activeExecutionDigest"])
        );
      }
    }
  }

  const grants = readJson(layout.capabilityGrantsFile) as {
    version?: number;
    grants?: Array<{
      capability?: string;
      effect?: string;
      revokedAt?: number;
      expiresAt?: number;
      binding?: {
        kind?: string;
        executionDigest?: string;
        resolvedExecutionDigest?: string;
      };
    }>;
  } | null;
  for (const [index, grant] of (grants?.grants ?? []).entries()) {
    if (
      grants?.version !== 2 ||
      grant.effect !== "allow" ||
      grant.revokedAt !== undefined ||
      (grant.expiresAt !== undefined && grant.expiresAt <= Date.now())
    ) {
      continue;
    }
    const executionDigest =
      grant.binding?.kind === "exact-execution"
        ? grant.binding.executionDigest
        : grant.binding?.kind === "selector"
          ? grant.binding.resolvedExecutionDigest
          : undefined;
    add("code-grant", `${grant.capability ?? "capability"}:${index}`, executionDigest);
  }

  const boot = readJson(path.join(statePath, "product-boot-manifest.json")) as {
    artifacts?: Array<{ id?: string; executionDigest?: string }>;
  } | null;
  for (const artifact of boot?.artifacts ?? []) {
    add("bootstrap-manifest", artifact.id ?? "boot-artifact", artifact.executionDigest);
  }

  const unique = new Map<string, ArtifactRetentionRoot>();
  for (const root of roots) {
    unique.set(`${root.kind}\0${root.id}\0${root.executionDigest}`, root);
  }
  return [...unique.values()].sort((left, right) =>
    `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`)
  );
}

function readJson(file: string): unknown | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(
      `Cannot collect artifact roots from ${file}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

export function artifactRootDigests(roots: readonly ArtifactRetentionRoot[]): Sha256[] {
  return [...new Set(roots.map((root) => root.executionDigest))];
}

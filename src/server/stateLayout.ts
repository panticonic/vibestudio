import * as path from "node:path";
import {
  contextProjectionsBasePath,
  currentContextProjectionsPath,
} from "@vibestudio/workspace/contextProjections";
import { gitCheckoutsPath } from "@vibestudio/workspace/gitCheckouts";

/**
 * Declared on-disk contract for one workspace's host state directory.
 *
 * Every path rooted directly at `statePath` belongs here so renames, cleanup,
 * backup, and migration code have one greppable source of truth. Components
 * handed one of these dedicated directories continue to own their internal
 * files.
 */
export function stateLayout(statePath: string) {
  const databases = path.join(statePath, ".databases");
  const contextProjectionsBase = contextProjectionsBasePath(statePath);
  const authority = path.join(statePath, "authority");
  return {
    root: statePath,
    adminTokenFile: path.join(statePath, "admin-token"),
    bootGenerationFile: path.join(statePath, ".boot-generation"),
    contextProjections: {
      base: contextProjectionsBase,
      current: currentContextProjectionsPath(statePath),
    },
    logsDir: path.join(statePath, "logs"),
    credentialsAuditDir: path.join(statePath, "credentials-audit"),
    credentialUseGrantsFile: path.join(statePath, "credential-use-grants.json"),
    disposableGitRemotesDir: path.join(statePath, "disposable-git-remotes"),
    gitCheckoutsDir: gitCheckoutsPath(statePath),
    runtimeImagesFile: path.join(statePath, "runtime-images.json"),
    runtimeDiagnosticsDir: path.join(statePath, "runtime-diagnostics"),
    refsDir: path.join(statePath, "refs"),
    blobsDir: path.join(statePath, "blobs"),
    buildSourcesDir: path.join(statePath, "build-sources"),
    hostTargetSelectionsFile: path.join(statePath, "host-targets", "selections.json"),
    ownerPanelSeedsDir: path.join(statePath, "panel-tree", "seeded-owners"),
    authority: {
      root: authority,
      grantsDb: path.join(authority, "grants.db"),
      approvedUnitVersionsFile: path.join(authority, "approved-unit-versions.json"),
      conduitBlessingsFile: path.join(authority, "conduit-blessings.json"),
    },
    governance: {
      root: path.join(statePath, "governance"),
      missionsDb: path.join(statePath, "governance", "missions.db"),
      contentTrustDb: path.join(statePath, "governance", "content-trust.db"),
    },
    databases: {
      root: databases,
      workerdDoDir: path.join(databases, "workerd-do"),
      workerdUniversalDoDir: path.join(databases, "workerd-universal-do"),
    },
  } as const;
}

export type StateLayout = ReturnType<typeof stateLayout>;

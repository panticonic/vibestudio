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
 * backup, and current-generation lifecycle code have one greppable source of truth. Components
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
    gitCheckoutsDir: gitCheckoutsPath(statePath),
    runtimeImagesFile: path.join(statePath, "runtime-images.json"),
    runtimeDiagnosticsDir: path.join(statePath, "runtime-diagnostics"),
    refsDir: path.join(statePath, "refs"),
    blobsDir: path.join(statePath, "blobs"),
    buildSourcesDir: path.join(statePath, "build-sources"),
    executionRetention: {
      root: path.join(statePath, "execution-retention"),
      publicationsDb: path.join(statePath, "execution-retention", "publications.db"),
      buildGcFile: path.join(statePath, "execution-retention", "build-gc.json"),
      buildTrashDir: path.join(statePath, "execution-retention", "build-trash"),
    },
    ownerPanelSeedsDir: path.join(statePath, "panel-tree", "seeded-owners"),
    authority: {
      root: authority,
      grantsDb: path.join(authority, "grants.db"),
      authorityPlansDb: path.join(authority, "authority-plans.db"),
      targetRequestsDb: path.join(authority, "target-requests.db"),
      resourceHandlesDb: path.join(authority, "resource-handles.db"),
      conduitBlessingsFile: path.join(authority, "conduit-blessings.json"),
    },
    development: {
      root: path.join(statePath, "development"),
      sessionsFile: path.join(statePath, "development", "sessions.json"),
      runsDb: path.join(statePath, "development", "runs.db"),
      attachedHostsDb: path.join(statePath, "development", "attached-hosts.db"),
      runsDir: path.join(statePath, "development", "runs"),
      nativeSessionsDir: path.join(statePath, "development", "native-sessions"),
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
      durableObjectMaintenanceDb: path.join(databases, "do-maintenance.db"),
      durableObjectSchemaDescriptorsDb: path.join(databases, "do-schema-descriptors.db"),
      durableObjectBackupsDir: path.join(databases, "do-backups"),
    },
  } as const;
}

export type StateLayout = ReturnType<typeof stateLayout>;

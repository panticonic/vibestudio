import * as path from "node:path";

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
  const units = path.join(statePath, "units");
  const webrtc = path.join(statePath, "webrtc");
  return {
    root: statePath,
    adminTokenFile: path.join(statePath, "admin-token"),
    bootGenerationFile: path.join(statePath, ".boot-generation"),
    contextsDir: path.join(statePath, ".contexts"),
    logsDir: path.join(statePath, "logs"),
    credentialsAuditDir: path.join(statePath, "credentials-audit"),
    credentialUseGrantsFile: path.join(statePath, "credential-use-grants.json"),
    capabilityGrantsFile: path.join(statePath, "capability-grants.json"),
    userlandApprovalGrantsFile: path.join(statePath, "userland-approval-grants.json"),
    disposableGitRemotesDir: path.join(statePath, "disposable-git-remotes"),
    runtimeImagesFile: path.join(statePath, "runtime-images.json"),
    runtimeDiagnosticsDir: path.join(statePath, "runtime-diagnostics"),
    refsDir: path.join(statePath, "refs"),
    blobsDir: path.join(statePath, "blobs"),
    buildSourcesDir: path.join(statePath, "build-sources"),
    hostTargetSelectionsFile: path.join(statePath, "host-targets", "selections.json"),
    ownerPanelSeedsDir: path.join(statePath, "panel-tree", "seeded-owners"),
    units: {
      root: units,
      metaApprovalGrantsFile: path.join(units, "meta-approval-grants.json"),
    },
    databases: {
      root: databases,
      workerdDoDir: path.join(databases, "workerd-do"),
      workerdUniversalDoDir: path.join(databases, "workerd-universal-do"),
    },
    webrtc: {
      root: webrtc,
      routesFile: path.join(webrtc, "routes.json"),
      pairingActivationsFile: path.join(webrtc, "pairing-activations.json"),
    },
  } as const;
}

export type StateLayout = ReturnType<typeof stateLayout>;

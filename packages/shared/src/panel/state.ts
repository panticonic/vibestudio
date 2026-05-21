import type { PanelArtifacts, PanelExplicitState } from "../types.js";
import type { PanelRuntimeLease } from "./panelLease.js";

export function explicitStateFromArtifacts(
  artifacts: PanelArtifacts,
  lease?: PanelRuntimeLease | null
): PanelExplicitState {
  return {
    build: {
      state: artifacts.buildState,
      revision: artifacts.buildRevision,
      artifactUrl: artifacts.htmlPath,
      bundlePath: artifacts.bundlePath,
      error: artifacts.error,
      progress: artifacts.buildProgress,
      log: artifacts.buildLog,
    },
    view: {
      exists: Boolean(artifacts.htmlPath),
      url: artifacts.htmlPath,
    },
    runtime: lease
      ? {
          leased: true,
          holderLabel: lease.holderLabel,
          platform: lease.platform,
          clientSessionId: lease.clientSessionId,
          connectionId: lease.connectionId,
        }
      : { leased: false },
  };
}

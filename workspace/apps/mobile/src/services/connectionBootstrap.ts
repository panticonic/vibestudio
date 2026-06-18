import {
  getCredentials,
  listWorkspaces,
  pairServer,
  selectWorkspace,
  type Credentials,
  type RemoteWorkspaceEntry,
} from "./auth";
import { devBootstrapConfig } from "../generated/devBootstrap";

export interface ConnectionBootstrap extends Credentials {
  autoConnect: boolean;
  source: "stored" | "dev-bootstrap";
  availableWorkspaces?: RemoteWorkspaceEntry[];
}

export async function getConnectionBootstrap(): Promise<ConnectionBootstrap | null> {
  const stored = await getCredentials();
  if (stored?.serverUrl && stored.deviceId) {
    if (!stored.workspaceId) {
      const availableWorkspaces = await listWorkspaces();
      return {
        ...stored,
        autoConnect: false,
        source: "stored",
        availableWorkspaces,
      };
    }
    return {
      ...stored,
      autoConnect: true,
      source: "stored",
    };
  }

  if (__DEV__ && devBootstrapConfig?.serverUrl && devBootstrapConfig.pairingCode) {
    if (!devBootstrapConfig.workspaceName) {
      throw new Error("Development bootstrap must include workspaceName");
    }
    await pairServer(devBootstrapConfig.serverUrl, devBootstrapConfig.pairingCode);
    const paired = await selectWorkspace(devBootstrapConfig.workspaceName);
    return {
      serverUrl: paired.serverUrl,
      hubUrl: paired.hubUrl,
      workspaceName: paired.workspaceName,
      deviceId: paired.deviceId,
      serverId: paired.serverId,
      workspaceId: paired.workspaceId,
      autoConnect: devBootstrapConfig.autoConnect ?? true,
      source: "dev-bootstrap",
    };
  }

  return null;
}

export interface WorkspaceChildSecrets {
  identityDbPath: string;
  hubUrl: string;
  workspaceChildToken: string;
  adminToken: string;
  relaySigningSecret?: string;
}

const SECRET_KEYS = [
  "VIBESTUDIO_IDENTITY_DB_PATH",
  "VIBESTUDIO_HUB_URL",
  "VIBESTUDIO_WORKSPACE_CHILD_TOKEN",
  "VIBESTUDIO_ADMIN_TOKEN",
  "VIBESTUDIO_RELAY_SIGNING_SECRET",
] as const;

/**
 * Capture the hub capabilities needed by the workspace runtime and immediately
 * remove them from the ambient environment. Workspace-controlled extensions,
 * terminals, and child processes inherit process.env, so these values must not
 * remain available after bootstrap.
 */
export function consumeWorkspaceChildSecrets(env: NodeJS.ProcessEnv): WorkspaceChildSecrets {
  const identityDbPath = env[SECRET_KEYS[0]];
  const hubUrl = env[SECRET_KEYS[1]];
  const workspaceChildToken = env[SECRET_KEYS[2]];
  const adminToken = env[SECRET_KEYS[3]];
  const relaySigningSecret = env[SECRET_KEYS[4]];

  for (const key of SECRET_KEYS) deleteDynamicProperty(env, key);

  if (!identityDbPath || !hubUrl || !workspaceChildToken || !adminToken) {
    throw new Error(
      "Workspace runtime requires identity, hub URL, runtime identity, and local admin capabilities from the hub"
    );
  }

  return {
    identityDbPath,
    hubUrl,
    workspaceChildToken,
    adminToken,
    ...(relaySigningSecret ? { relaySigningSecret } : {}),
  };
}
import { deleteDynamicProperty } from "../lintHelpers.js";

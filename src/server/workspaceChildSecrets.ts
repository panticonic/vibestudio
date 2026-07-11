export interface WorkspaceChildSecrets {
  identityDbPath: string;
  hubUrl: string;
  hubControlToken: string;
  adminToken: string;
  relaySigningSecret?: string;
}

const SECRET_KEYS = [
  "VIBESTUDIO_IDENTITY_DB_PATH",
  "VIBESTUDIO_HUB_URL",
  "VIBESTUDIO_HUB_CONTROL_TOKEN",
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
  const hubControlToken = env[SECRET_KEYS[2]];
  const adminToken = env[SECRET_KEYS[3]];
  const relaySigningSecret = env[SECRET_KEYS[4]];

  for (const key of SECRET_KEYS) deleteDynamicProperty(env, key);

  if (!identityDbPath || !hubUrl || !hubControlToken || !adminToken) {
    throw new Error(
      "Workspace runtime requires identity, workspace, hub URL, and control capabilities from the hub"
    );
  }

  return {
    identityDbPath,
    hubUrl,
    hubControlToken,
    adminToken,
    ...(relaySigningSecret ? { relaySigningSecret } : {}),
  };
}
import { deleteDynamicProperty } from "../lintHelpers.js";

import {
  establishWebRtcConnection,
  makeShellTokenProvider,
  persistStoredShellCredential,
} from "./connect.js";
import { createStoredShellCredential, type StoredShellCredential } from "./storedCredential.js";
import { createMobileHubControlClient, type MobileHubControlClient } from "./hubControlClient.js";

export interface MobileHubControlConnection {
  readonly client: MobileHubControlClient;
  /** The latest durably stored credential, including any refresh-token rotation. */
  getStoredCredential(): StoredShellCredential;
  close(): Promise<void>;
}

/**
 * Open a short-lived management connection over the stable control pairing.
 * This never tears down or mutates the active workspace connection. If the hub
 * rotates the device refresh secret, the exact two-reach credential is durable
 * before the connection is exposed to callers.
 */
export async function connectMobileHubControl(
  stored: StoredShellCredential
): Promise<MobileHubControlConnection> {
  let currentStored = stored;
  const persistFailure: { current: Error | null } = { current: null };
  const tokenProvider = makeShellTokenProvider(stored.controlPairing, {
    deviceId: stored.deviceId,
    refreshToken: stored.refreshToken,
  });
  const connection = await establishWebRtcConnection(stored.controlPairing, tokenProvider, {
    onPaired: async (credential) => {
      tokenProvider.setCredential(credential);
      const next = createStoredShellCredential(
        credential,
        currentStored.controlPairing,
        currentStored.workspacePairing,
        currentStored.pairedAt
      );
      await persistStoredShellCredential(next);
      currentStored = next;
    },
    onPersistError: (error) => {
      persistFailure.current = error;
    },
  });
  if (persistFailure.current) {
    const error = new Error(
      `Failed to persist the rotated mobile device credential: ${persistFailure.current.message}`
    );
    try {
      await connection.close();
    } catch (closeError) {
      const closeMessage = closeError instanceof Error ? closeError.message : String(closeError);
      throw new Error(`${error.message}; control connection cleanup also failed: ${closeMessage}`);
    }
    throw error;
  }
  return {
    client: createMobileHubControlClient(connection),
    getStoredCredential: () => currentStored,
    close: () => connection.close(),
  };
}

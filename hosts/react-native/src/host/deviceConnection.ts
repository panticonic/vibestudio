import {
  clearShellCredential,
  combineMobileFailures,
  completeFreshMobilePairing,
  connectMobileAccount,
  createMobileHubControlClient,
  createMobileIrohIdentity,
  deleteMobileIrohIdentity,
  establishIrohConnection,
  loadShellCredential,
  makeFreshShellTokenProvider,
  makeReturningShellTokenProvider,
  persistStoredMobileConnection,
  replaceMobileConnectionCredential,
  type FreshShellPairing,
  type IrohConnection,
  type MobileWorkspaceAccount,
} from "@vibestudio/mobile-iroh";
import { createRecoveryCoordinator } from "@vibestudio/shell-core/recoveryCoordinator";
import type { RecoveryCoordinator } from "@vibestudio/shell-core/recoveryCoordinator";
import type { WorkspaceAccount } from "./hostConnections";

/** The device's live connection to its account, routed to the System workspace clients launch from. */
export interface DeviceConnection {
  account: WorkspaceAccount;
  /** The System workspace connection: the host's own session for launch, grants and server events. */
  launch: IrohConnection;
  systemWorkspaceId: string;
  /** Run on every recovery of the launch connection (resubscribe server events). */
  recovery: RecoveryCoordinator;
  close(): Promise<void>;
}

/** Everything the host does with the device's credential, in one place. Clients never reach it. */
export interface DevicePorts {
  isPaired(): Promise<boolean>;
  /** Reconnect with the stored credential. Rejects with `code: "SESSION_AUTH_FAILED"` when the server refuses it. */
  connect(): Promise<DeviceConnection>;
  /** Redeem a pairing code, persist the credential and release the pairing connections. */
  pair(pairing: FreshShellPairing): Promise<void>;
  /** Forget this device's pairing (credential and endpoint identity). */
  forget(): Promise<void>;
}

export function createDevicePorts(options: {
  oauthCallbackMode: "app-scheme" | "client-loopback";
  smokePhase?: (phase: string) => void;
}): DevicePorts {
  const { oauthCallbackMode } = options;
  const smoke = options.smokePhase ?? (() => undefined);
  return {
    async isPaired() {
      return (await loadShellCredential()) !== null;
    },

    async connect() {
      const stored = await loadShellCredential();
      if (!stored) throw new Error("This device is not paired with a Vibestudio server.");
      const account: MobileWorkspaceAccount = await connectMobileAccount(stored, oauthCallbackMode);
      try {
        const hub = createMobileHubControlClient(account.control);
        const { system } = await hub.ensureUserWorkspaces();
        const recovery = createRecoveryCoordinator();
        const launch = await account.openWorkspace(system.workspaceId, (kind) =>
          recovery.run(kind)
        );
        return {
          account,
          launch,
          systemWorkspaceId: system.workspaceId,
          recovery,
          close: () => account.close(),
        };
      } catch (error) {
        try {
          await account.close();
        } catch (closeError) {
          throw combineMobileFailures(error, closeError, "Mobile connection failed");
        }
        throw error;
      }
    },

    async pair(pairing) {
      smoke("embedded-pairing-start");
      const identity = await createMobileIrohIdentity();
      const tokenProvider = makeFreshShellTokenProvider(pairing);
      let pairedCredential: Parameters<typeof tokenProvider.setCredential>[0] = null;
      try {
        const connection = await establishIrohConnection(
          pairing,
          tokenProvider,
          identity.identityId,
          oauthCallbackMode,
          {
            onPaired: (credential) => {
              pairedCredential = credential;
              tokenProvider.setCredential(credential);
            },
          }
        );
        const workspaceConnection = await completeFreshMobilePairing({
          controlConnection: connection,
          credential: pairedCredential,
          controlPairing: pairing,
          persistConnection: persistStoredMobileConnection,
          connectWorkspace: async (workspacePairing, credential, controlConnection) => {
            const workspaceTokens = makeReturningShellTokenProvider(credential);
            return establishIrohConnection(
              workspacePairing,
              workspaceTokens,
              identity.identityId,
              oauthCallbackMode,
              {
                onPaired: async (nextCredential) => {
                  workspaceTokens.setCredential(nextCredential);
                  const current = await loadShellCredential();
                  if (!current || current.schemaVersion !== 6 || current.phase !== "routed") {
                    throw new Error(
                      "Routed mobile connection disappeared during workspace authentication"
                    );
                  }
                  await persistStoredMobileConnection(
                    replaceMobileConnectionCredential(current, nextCredential)
                  );
                },
              },
              controlConnection.endpointPool
            );
          },
        });
        // The credential is durable. The live connection is reopened as the
        // account (one physical connection per reach); release this one first so
        // the two never supersede each other.
        await workspaceConnection.close();
        smoke("embedded-pairing-complete");
      } catch (error) {
        smoke("embedded-pairing-failed");
        const stored = await loadShellCredential().catch(() => null);
        if (stored?.deviceIdentityId !== identity.identityId) {
          await deleteMobileIrohIdentity(identity.identityId).catch(() => undefined);
        }
        throw error;
      }
    },

    forget: () => clearShellCredential(),
  };
}

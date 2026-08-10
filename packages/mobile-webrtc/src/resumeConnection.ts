import { HubWorkspaceRouteSchema } from "@vibestudio/service-schemas/hubControl";
import { workspaceMethods } from "@vibestudio/service-schemas/workspace";
import type { WebRtcConnection } from "./connect.js";
import { composeMobileSession } from "./connectionPair.js";
import {
  createRoutedMobileConnection,
  migrateLegacyMobileConnection,
  type LoadedMobileConnection,
  type StoredMobileConnection,
} from "./storedCredential.js";

export interface ResumeMobileConnectionDependencies {
  connect(
    stored: LoadedMobileConnection,
    reach: "control" | "workspace",
    onCredentialStored: (stored: LoadedMobileConnection) => void
  ): Promise<WebRtcConnection>;
  persist(connection: StoredMobileConnection): Promise<void>;
}

async function closeAfterFailure(
  close: () => Promise<void>,
  failure: unknown,
  context: string
): Promise<void> {
  try {
    await close();
  } catch (closeError) {
    const failureMessage = failure instanceof Error ? failure.message : String(failure);
    const closeMessage = closeError instanceof Error ? closeError.message : String(closeError);
    throw new Error(`${context} (${failureMessage}) and cleanup failed (${closeMessage})`);
  }
}

/**
 * Complete the durable mobile lifecycle after loading its one secure-store item.
 * A paired v4 record is routed and replaced before its workspace pipe opens.
 * Strict v3 records recover the authoritative workspace identity from their
 * already-authenticated workspace, then atomically become routed v4 records
 * before the composed session is exposed.
 */
export async function resumeMobileConnection(
  stored: LoadedMobileConnection,
  dependencies: ResumeMobileConnectionDependencies
): Promise<WebRtcConnection> {
  let current = stored;
  const updateCurrent = (next: LoadedMobileConnection): void => {
    current = next;
  };
  const control = await dependencies.connect(current, "control", updateCurrent);
  try {
    if (current.schemaVersion === 3) {
      const workspace = await dependencies.connect(current, "workspace", updateCurrent);
      try {
        if (current.schemaVersion !== 3) {
          throw new Error("Legacy mobile credential changed schema during migration");
        }
        const info = workspaceMethods.getInfo.returns.parse(
          await workspace.rpc.call("main", "workspace.getInfo", [])
        );
        const migrated = migrateLegacyMobileConnection(current, info.config.id);
        await dependencies.persist(migrated);
        return composeMobileSession(control, workspace);
      } catch (error) {
        await closeAfterFailure(() => workspace.close(), error, "Legacy mobile migration failed");
        throw error;
      }
    }

    if (current.phase === "paired") {
      const route = HubWorkspaceRouteSchema.parse(
        await control.rpc.call("main", "hubControl.routeWorkspace", [
          { workspaceId: current.selectedWorkspaceId },
        ])
      );
      if (route.workspaceId !== current.selectedWorkspaceId) {
        throw new Error("Workspace route changed the selected workspace identity");
      }
      const routed = createRoutedMobileConnection(current, route.workspaceReach);
      await dependencies.persist(routed);
      current = routed;
    }

    const workspace = await dependencies.connect(current, "workspace", updateCurrent);
    return composeMobileSession(control, workspace);
  } catch (error) {
    await closeAfterFailure(
      () => control.close(),
      error,
      "Mobile workspace connection failed after hub control connected"
    );
    throw error;
  }
}

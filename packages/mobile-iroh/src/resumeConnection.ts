import { HubWorkspaceRouteSchema } from "@vibestudio/service-schemas/hubControl";
import type { IrohConnection } from "./connect.js";
import { composeMobileSession } from "./connectionPair.js";
import { createRoutedMobileConnection, type StoredMobileConnection } from "./storedCredential.js";

export interface ResumeMobileConnectionDependencies {
  connect(
    stored: StoredMobileConnection,
    reach: "control" | "workspace",
    onCredentialStored: (stored: StoredMobileConnection) => void,
    controlConnection?: IrohConnection
  ): Promise<IrohConnection>;
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
 * A paired record is routed and replaced before its workspace pipe opens.
 */
export async function resumeMobileConnection(
  stored: StoredMobileConnection,
  dependencies: ResumeMobileConnectionDependencies
): Promise<IrohConnection> {
  let current = stored;
  const updateCurrent = (next: StoredMobileConnection): void => {
    current = next;
  };
  const control = await dependencies.connect(current, "control", updateCurrent);
  try {
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

    const workspace = await dependencies.connect(current, "workspace", updateCurrent, control);
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

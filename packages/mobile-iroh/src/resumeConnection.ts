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
  connectRoutedPair?(
    stored: Extract<StoredMobileConnection, { phase: "routed" }>,
    onCredentialStored: (stored: StoredMobileConnection) => void
  ): Promise<{ control: IrohConnection; workspace: IrohConnection }>;
}

export async function restoreRoutedConnectionPair<T extends { close(): Promise<void> }>(
  openControl: () => Promise<T>,
  openWorkspace: () => Promise<T>
): Promise<{ control: T; workspace: T }> {
  // Invoke both before awaiting either. Hub and workspace are independent
  // logical sessions sharing one endpoint pool; serial dialing only adds a
  // complete relay handshake to returning-device startup.
  const attempts = await Promise.allSettled([openControl(), openWorkspace()]);
  const [controlResult, workspaceResult] = attempts;
  if (controlResult.status === "fulfilled" && workspaceResult.status === "fulfilled") {
    return { control: controlResult.value, workspace: workspaceResult.value };
  }

  const cleanup = await Promise.allSettled(
    attempts.flatMap((result) => (result.status === "fulfilled" ? [result.value.close()] : []))
  );
  throw new AggregateError(
    [
      ...attempts.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
      ...cleanup.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
    ],
    "Unable to restore the mobile hub and workspace Iroh pair"
  );
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
  if (stored.phase === "routed" && dependencies.connectRoutedPair) {
    const pair = await dependencies.connectRoutedPair(stored, updateCurrent);
    return composeMobileSession(pair.control, pair.workspace);
  }
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

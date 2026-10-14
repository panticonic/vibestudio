import { assertIrohReach, type IrohReach } from "@vibestudio/iroh-transport";
import type { IrohIngress } from "./irohIngress.js";

/** Coordinates identify a bound endpoint, not a successful relay connection.
 * Local RPC readiness depends on binding and semantic publication; remote
 * availability remains owned by the ingress and the connecting transport. */
export function workspaceIrohReach(
  ingress: Pick<IrohIngress<{ reach(relays: readonly string[]): IrohReach }>, "endpoint"> | null,
  relays: readonly string[]
): IrohReach {
  if (!ingress) throw new Error("Workspace Iroh ingress is not ready");
  const reach = ingress.endpoint.reach(relays);
  assertIrohReach(reach);
  return reach;
}

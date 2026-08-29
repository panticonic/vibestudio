import { IROH_REACH_VERSION, assertIrohReach, type IrohReach } from "@vibestudio/iroh-transport";
export { DEFAULT_IROH_RELAYS } from "../../scripts/cli/lib/iroh-relays.mjs";
import { DEFAULT_IROH_RELAYS } from "../../scripts/cli/lib/iroh-relays.mjs";

export function resolveIrohRelayUrls(raw: string | undefined): string[] {
  const relays = raw === undefined ? [...DEFAULT_IROH_RELAYS] : raw.split(",");
  const reach: IrohReach = { endpointId: "00".repeat(32), relays, v: IROH_REACH_VERSION };
  assertIrohReach(reach);
  return [...reach.relays];
}

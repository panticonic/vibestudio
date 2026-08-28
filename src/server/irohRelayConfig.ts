import { IROH_REACH_VERSION, assertIrohReach, type IrohReach } from "@vibestudio/iroh-transport";

const DEFAULT_IROH_RELAYS = [
  "https://relay.vibestudio.app/",
  "https://relay-eu.vibestudio.app/",
] as const;

export function resolveIrohRelayUrls(raw: string | undefined): string[] {
  const relays = raw === undefined ? [...DEFAULT_IROH_RELAYS] : raw.split(",");
  const reach: IrohReach = { endpointId: "00".repeat(32), relays, v: IROH_REACH_VERSION };
  assertIrohReach(reach);
  return [...reach.relays];
}

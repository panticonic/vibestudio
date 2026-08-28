import { IROH_REACH_VERSION, assertIrohReach, type IrohReach } from "@vibestudio/iroh-transport";

export const DEFAULT_IROH_RELAYS = [
  "https://use1-1.relay.n0.iroh.link/",
  "https://euc1-1.relay.n0.iroh.link/",
] as const;

export function resolveIrohRelayUrls(raw: string | undefined): string[] {
  const relays = raw === undefined ? [...DEFAULT_IROH_RELAYS] : raw.split(",");
  const reach: IrohReach = { endpointId: "00".repeat(32), relays, v: IROH_REACH_VERSION };
  assertIrohReach(reach);
  return [...reach.relays];
}

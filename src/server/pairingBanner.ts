import { type ConnectPairing, createConnectDeepLink } from "@vibestudio/shared/connect";

export function formatPairUrlLine(pairing: ConnectPairing): string {
  return `  Pair URL:     ${createConnectDeepLink(pairing)}`;
}

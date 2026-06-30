import { type ConnectPairing, createConnectDeepLink } from "@vibez1/shared/connect";

export function formatPairUrlLine(pairing: ConnectPairing): string {
  return `  Pair URL:     ${createConnectDeepLink(pairing)}`;
}

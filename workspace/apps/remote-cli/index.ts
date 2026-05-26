import { createConnectDeepLink } from "@natstack/shared/connect";

export interface PairingInviteLike {
  connectUrl: string;
  code: string;
  deepLink?: string | null;
}

export function formatPairingInvite(invite: PairingInviteLike): string {
  const deepLink = invite.deepLink ?? createConnectDeepLink(invite.connectUrl, invite.code);
  return [
    `Pairing code: ${invite.code}`,
    `Pair URL: ${deepLink}`,
  ].join("\n");
}

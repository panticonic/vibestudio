// Parsing + validation for `natstack://connect?url=…&code=…` deep links.
//
// The deep-link flow is user-triggered onboarding (scan QR, tap link), which
// means any installed Android app can fire one. Without validation, an
// attacker could redirect the client to a server they control with a pairing code
// they chose. The checks below constrain what can be auto-applied:
//
//   - Only http:// or https:// server URLs.
//   - http:// is accepted only for hosts where cleartext is either local to
//     the device, on a private LAN segment, inside a Tailscale tailnet
//     (which already encrypts end-to-end), or addressed by a single-label /
//     .local hostname that only resolves in local trusted networks. Everything
//     else requires https.
//   - Pairing code must match a plausible character set/length so obvious junk
//     is rejected before we try to pair with it.
//
// The UI layer is still responsible for asking the user to confirm before
// overwriting credentials — this module only decides whether the link is
// structurally safe to propose.

import { isTrustedCleartextHost, parseConnectLink } from "@natstack/shared/connect";

export { isTrustedCleartextHost };

export type ConnectDeepLinkResult =
  | { kind: "ok"; serverUrl: string; pairingCode: string }
  | { kind: "error"; reason: string };

export function parseConnectDeepLink(rawUrl: string): ConnectDeepLinkResult {
  const parsed = parseConnectLink(rawUrl);
  if (parsed.kind === "error") return parsed;
  return { kind: "ok", serverUrl: parsed.url, pairingCode: parsed.code };
}

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const qrcode = require("qrcode-terminal");

export function printConnectBanner({
  title,
  invite,
  qrInvite = invite,
  deepLinkLabel = "Deep link",
  instructions = "Open the QR code with the Android camera. Vibestudio will confirm and save the connection.",
}) {
  for (const [label, value] of [
    ["invite.endpointId", invite?.endpointId],
    ["invite.code", invite?.code],
    ["invite.pairUrl", invite?.pairUrl],
    ["qrInvite.pairUrl", qrInvite?.pairUrl],
  ]) {
    if (typeof value !== "string" || !value) throw new Error(`${label} is required`);
  }
  if (!Array.isArray(invite.relays) || invite.relays.length === 0) {
    throw new Error("invite.relays is required");
  }
  const divider = "=".repeat(72);
  console.log(`\n${divider}`);
  console.log(`  ${title}`);
  console.log(divider);
  console.log(`  Endpoint ID: ${invite.endpointId}`);
  console.log(`  Relays:      ${invite.relays.join(", ")}`);
  console.log(`  Pair code:   ${invite.code}`);
  if (qrInvite.code !== invite.code) {
    console.log(`  QR code:     ${qrInvite.code}`);
  }
  console.log(`  ${deepLinkLabel}:  ${invite.pairUrl}`);
  if (qrInvite.pairUrl !== invite.pairUrl) {
    console.log(`  QR ${deepLinkLabel}:  ${qrInvite.pairUrl}`);
  }
  console.log(`  Desktop:    vibestudio open ${invite.pairUrl}`);
  console.log("  One-time:   Pairs one device; accepted links cannot be replayed.");
  console.log();
  qrcode.generate(qrInvite.pairUrl, { small: true });
  console.log(divider);
  console.log(`  ${instructions}`);
  console.log(`${divider}\n`);
}

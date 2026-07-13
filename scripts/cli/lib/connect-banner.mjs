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
    ["invite.room", invite?.room],
    ["invite.fp", invite?.fp],
    ["invite.sig", invite?.sig],
    ["invite.code", invite?.code],
    ["invite.pairUrl", invite?.pairUrl],
    ["qrInvite.pairUrl", qrInvite?.pairUrl],
  ]) {
    if (typeof value !== "string" || !value) throw new Error(`${label} is required`);
  }
  const divider = "=".repeat(72);
  console.log(`\n${divider}`);
  console.log(`  ${title}`);
  console.log(divider);
  console.log(`  Room:        ${invite.room}`);
  console.log(`  Fingerprint: ${invite.fp}`);
  console.log(`  Signaling:   ${invite.sig}`);
  console.log(`  Pair code:   ${invite.code}`);
  if (qrInvite.code !== invite.code) {
    console.log(`  QR code:     ${qrInvite.code}`);
  }
  console.log(`  ${deepLinkLabel}:  ${invite.pairUrl}`);
  if (qrInvite.pairUrl !== invite.pairUrl) {
    console.log(`  QR ${deepLinkLabel}:  ${qrInvite.pairUrl}`);
  }
  console.log();
  qrcode.generate(qrInvite.pairUrl, { small: true });
  console.log(divider);
  console.log(`  ${instructions}`);
  console.log(`${divider}\n`);
}

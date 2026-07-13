import { createHash } from "node:crypto";
import { OAuthConnectionError } from "./errors.js";

export function sshPublicKeyFingerprint(publicKey: string): string {
  return `SHA256:${createHash("sha256").update(publicKey).digest("base64url")}`;
}

export function openSshEd25519PublicKey(spkiDer: Buffer): string {
  const keyBytes = spkiDer.subarray(-32);
  if (keyBytes.length !== 32) {
    throw new OAuthConnectionError(
      "invalid_connection_spec",
      "Unable to derive Ed25519 public key"
    );
  }
  const type = Buffer.from("ssh-ed25519");
  const wire = Buffer.concat([uint32(type.length), type, uint32(keyBytes.length), keyBytes]);
  return `ssh-ed25519 ${wire.toString("base64")}`;
}

function uint32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value, 0);
  return buffer;
}

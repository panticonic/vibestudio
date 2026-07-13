import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { openSshEd25519PublicKey, sshPublicKeyFingerprint } from "./ssh.js";

describe("SSH key formatting", () => {
  it("formats an Ed25519 SPKI key as an OpenSSH public key", () => {
    const pair = generateKeyPairSync("ed25519");
    const spki = pair.publicKey.export({ type: "spki", format: "der" });
    const publicKey = openSshEd25519PublicKey(spki);
    const [, encoded] = publicKey.split(" ");
    const wire = Buffer.from(encoded!, "base64");
    expect(wire.readUInt32BE(0)).toBe("ssh-ed25519".length);
    expect(wire.subarray(4, 15).toString("utf8")).toBe("ssh-ed25519");
    expect(wire.readUInt32BE(15)).toBe(32);
    expect(wire.subarray(19)).toEqual(spki.subarray(-32));
    expect(sshPublicKeyFingerprint(publicKey)).toMatch(/^SHA256:[A-Za-z0-9_-]{43}$/);
  });

  it("rejects input too short to contain an Ed25519 key", () => {
    expect(() => openSshEd25519PublicKey(Buffer.from([1, 2, 3]))).toThrow(
      expect.objectContaining({ code: "invalid_connection_spec" })
    );
  });
});

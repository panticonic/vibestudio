import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { ChronologSigningVault } from "./signingVault.js";

it("stores one encrypted signing identity per account across concurrent creation and reopening", async () => {
  const root = mkdtempSync(join(tmpdir(), "chronolog-signing-"));
  vi.stubEnv("XDG_CONFIG_HOME", root);
  try {
    const path = join(root, "accounts");
    const [first, simultaneous] = await Promise.all([
      new ChronologSigningVault(path).principal("usr_first"),
      new ChronologSigningVault(path).principal("usr_first"),
    ]);
    expect(simultaneous.publicKey).toBe(first.publicKey);
    expect(simultaneous.pkcs8Hex === first.pkcs8Hex).toBe(true);
    const reopened = await new ChronologSigningVault(path).principal("usr_first");
    expect(reopened.publicKey).toBe(first.publicKey);
    expect(reopened.pkcs8Hex === first.pkcs8Hex).toBe(true);
    const second = await new ChronologSigningVault(path).principal("usr_second");
    expect(second.publicKey).not.toBe(first.publicKey);
    const persisted = readFileSync(join(path, "usr_first", "ed25519.json"), "utf8");
    expect(JSON.parse(persisted).v).toBe("v1-aesgcm");
    expect(persisted.includes(first.pkcs8Hex)).toBe(false);
    const privateKey = await crypto.subtle.importKey("pkcs8", Buffer.from(first.pkcs8Hex, "hex"), "Ed25519", false, ["sign"]);
    const publicKey = await crypto.subtle.importKey("raw", Buffer.from(first.publicKey, "hex"), "Ed25519", false, ["verify"]);
    const challenge = new TextEncoder().encode("Chronolog principal test");
    const signature = await crypto.subtle.sign("Ed25519", privateKey, challenge);
    expect(await crypto.subtle.verify("Ed25519", publicKey, signature, challenge)).toBe(true);
  } finally {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});

import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { it, expect, vi } from "vitest";
import { __setSafeStorageForTests } from "@vibestudio/credential-client/encryptedJsonStore";
import { createMachineReportSigner } from "./signing";
import { reportSignaturePayload } from "@vibestudio/service-schemas/problemReportBundle";
it("creates one encrypted machine key across concurrent owners, survives restart, and binds each submission and receipt", async () => {
  const root = mkdtempSync(join(tmpdir(), "report-signing-"));
  vi.stubEnv("XDG_CONFIG_HOME", root);
  try {
    const path = join(root, "secrets"),
      id = crypto.randomUUID(),
      digest = "a".repeat(64),
      receipt = "b".repeat(64);
    const [first, second] = await Promise.all([
      createMachineReportSigner(path)(id, digest, receipt),
      createMachineReportSigner(path)(id, digest, receipt),
    ]);
    expect(second).toEqual(first);
    expect(await createMachineReportSigner(path)(id, digest, receipt)).toEqual(first);
    const publicKey = await crypto.subtle.importKey(
      "raw",
      Buffer.from(first.publicKey, "hex"),
      "Ed25519",
      false,
      ["verify"]
    );
    expect(
      await crypto.subtle.verify(
        "Ed25519",
        publicKey,
        Buffer.from(first.signature, "hex"),
        reportSignaturePayload(id, digest, receipt)
      )
    ).toBe(true);
    expect(
      await crypto.subtle.verify(
        "Ed25519",
        publicKey,
        Buffer.from(first.signature, "hex"),
        reportSignaturePayload(crypto.randomUUID(), digest, receipt)
      )
    ).toBe(false);
    expect(
      await crypto.subtle.verify(
        "Ed25519",
        publicKey,
        Buffer.from(first.signature, "hex"),
        reportSignaturePayload(id, digest, "c".repeat(64))
      )
    ).toBe(false);
    expect(readFileSync(join(path, "machine", "ed25519.json"), "utf8")).not.toContain(
      "PRIVATE KEY"
    );
  } finally {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});

it("shares the machine key between an Electron writer and a Node reader without changing the public key", async () => {
  const root = mkdtempSync(join(tmpdir(), "report-signing-processes-"));
  vi.stubEnv("XDG_CONFIG_HOME", root);
  const encryptString = vi.fn((text: string) => Buffer.from(text));
  try {
    __setSafeStorageForTests({
      isEncryptionAvailable: () => true,
      encryptString,
      decryptString: (bytes) => bytes.toString(),
    });
    const path = join(root, "secrets");
    const id = crypto.randomUUID(),
      digest = "a".repeat(64),
      receipt = "b".repeat(64);
    const desktop = await createMachineReportSigner(path)(id, digest, receipt);
    __setSafeStorageForTests(null);
    const server = await createMachineReportSigner(path)(id, digest, receipt);
    expect(server).toEqual(desktop);
    expect(encryptString).not.toHaveBeenCalled();
    expect(JSON.parse(readFileSync(join(path, "machine", "ed25519.json"), "utf8")).v).toBe(
      "v1-aesgcm"
    );
  } finally {
    __setSafeStorageForTests(null);
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }
});

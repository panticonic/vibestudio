import * as crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";

const execSync = vi.hoisted(() =>
  vi.fn(() => {
    throw new Error("no keyring");
  })
);
vi.mock("node:child_process", () => ({ execSync }));

const { ChromiumCrypto } = await import("../crypto/chromiumCrypto.js");
const { deriveKey } = await import("../crypto/platforms/linux.js");

function encryptV11(plaintext: string, password: string): Buffer {
  const cipher = crypto.createCipheriv("aes-128-cbc", deriveKey(password), Buffer.alloc(16, 0x20));
  return Buffer.concat([Buffer.from("v11"), cipher.update(plaintext, "utf-8"), cipher.final()]);
}

describe("ChromiumCrypto v11 without a keyring", () => {
  it("asks the keyring once and decrypts every value with the fallback key", async () => {
    const chromium = new ChromiumCrypto("linux");

    const values = await Promise.all(
      ["one", "two", "three"].map((text) =>
        chromium.decrypt(encryptV11(text, "peanuts"), "chrome", "")
      )
    );

    expect(values).toEqual(["one", "two", "three"]);
    // secret-tool and kwallet-query, each once.
    expect(execSync).toHaveBeenCalledTimes(2);
  });
});

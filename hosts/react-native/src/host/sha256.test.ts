import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { installSubtleDigest, sha256 } from "./sha256";

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

describe("sha256", () => {
  it("matches node for the padding boundaries and a large input", () => {
    for (const size of [0, 1, 55, 56, 63, 64, 65, 119, 120, 1000, 300_001]) {
      const input = randomBytes(size);
      expect(hex(sha256(input))).toBe(createHash("sha256").update(input).digest("hex"));
    }
  });

  it("provides crypto.subtle.digest only where the platform lacks it", async () => {
    const target: { crypto?: unknown } = {};
    installSubtleDigest(target);
    const subtle = (target.crypto as { subtle: SubtleCrypto }).subtle;
    const digest = await subtle.digest("SHA-256", new TextEncoder().encode("abc"));
    expect(hex(new Uint8Array(digest))).toBe(createHash("sha256").update("abc").digest("hex"));
    await expect(subtle.digest("SHA-1", new Uint8Array())).rejects.toThrow("Unsupported");

    const own = { subtle: { digest: () => "own" } };
    const present: { crypto?: unknown } = { crypto: own };
    installSubtleDigest(present);
    expect(present.crypto).toBe(own);
  });
});

import { describe, expect, it, vi } from "vitest";
import { secureRandomUuid, type SecureRandomSource } from "./randomId.js";

describe("secureRandomUuid", () => {
  it("uses a runtime-native randomUUID implementation when available", () => {
    const randomUUID = vi.fn(() => "11111111-2222-4333-8444-555555555555");
    expect(secureRandomUuid({ randomUUID })).toBe("11111111-2222-4333-8444-555555555555");
    expect(randomUUID).toHaveBeenCalledOnce();
  });

  it("builds a standards-compliant UUID from secure bytes in Hermes-shaped runtimes", () => {
    const source: SecureRandomSource = {
      getRandomValues(bytes) {
        bytes.set([0, 1, 2, 3, 4, 5, 0xff, 7, 0xff, 9, 10, 11, 12, 13, 14, 15]);
        return bytes;
      },
    };

    expect(secureRandomUuid(source)).toBe("00010203-0405-4f07-bf09-0a0b0c0d0e0f");
  });

  it("fails explicitly instead of creating predictable protocol identities", () => {
    expect(() => secureRandomUuid({})).toThrow(
      "Secure random ID generation requires crypto.getRandomValues()"
    );
  });
});

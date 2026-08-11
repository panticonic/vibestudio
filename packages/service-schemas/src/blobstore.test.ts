import { afterEach, describe, expect, it, vi } from "vitest";
import { Base64Schema } from "./blobstore.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Base64Schema", () => {
  it("validates canonical byte payloads without relying on Node Buffer", () => {
    vi.stubGlobal("Buffer", undefined);

    expect(Base64Schema.safeParse("iVBORw0KGgo=").success).toBe(true);
    expect(Base64Schema.safeParse("aGVsbG8").success).toBe(true);
  });

  it("rejects malformed payloads", () => {
    expect(Base64Schema.safeParse("not base64").success).toBe(false);
    expect(Base64Schema.safeParse("a").success).toBe(false);
  });
});

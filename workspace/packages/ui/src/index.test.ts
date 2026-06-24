import { describe, expect, it } from "vitest";

describe("@workspace/ui root import", () => {
  it("does not require panel runtime globals", async () => {
    await expect(import("@workspace/ui")).resolves.toBeDefined();
  });
});

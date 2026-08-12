import { describe, expect, it } from "vitest";

import { accountProfileUpdateSchema } from "./account.js";

describe("account profile handle schema", () => {
  it("uses host identity reservations rather than userland tool names", () => {
    expect(accountProfileUpdateSchema.safeParse({ handle: "read" }).success).toBe(true);
    expect(accountProfileUpdateSchema.safeParse({ handle: "SYSTEM" }).success).toBe(false);
  });
});

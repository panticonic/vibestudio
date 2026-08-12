import { describe, expect, it } from "vitest";

import { isValidHandle } from "./types.js";

describe("account handle ownership", () => {
  it("reserves host principals without inheriting userland tool names", () => {
    expect(isValidHandle("system")).toBe(false);
    expect(isValidHandle("SYSTEM")).toBe(false);

    for (const handle of ["read", "edit", "write", "grep", "find", "ls"]) {
      expect(isValidHandle(handle)).toBe(true);
    }
  });
});

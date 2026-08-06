import { describe, expect, it } from "vitest";
import { systemTestUtilityKeys } from "./index.js";

describe("system-test utility scope ownership", () => {
  it("gives concurrent utility calls distinct finite scope identities", () => {
    const first = systemTestUtilityKeys("doctor", "call-a");
    const second = systemTestUtilityKeys("doctor", "call-b");

    expect(first).not.toEqual(second);
    expect(first.subKey).toBe("system-test-doctor-call-a");
    expect(first.scopeKey).toBe("$systemTestUtility:doctor:call-a");
    expect(second.subKey).toBe("system-test-doctor-call-b");
    expect(second.scopeKey).toBe("$systemTestUtility:doctor:call-b");
  });
});

import { describe, expect, it } from "vitest";
import { privateAccountSubject, withPrivateAccountSubject } from "./actorIdentity.js";

describe("private actor account identity", () => {
  it("merges a verified subject into existing metadata", () => {
    const actor = withPrivateAccountSubject(
      { id: "do:agent", kind: "do", metadata: { executionMode: "headless" } },
      { userId: "usr_alice" }
    );

    expect(actor).toEqual({
      id: "do:agent",
      kind: "do",
      metadata: {
        executionMode: "headless",
        accountSubject: { userId: "usr_alice" },
      },
    });
    expect(privateAccountSubject(actor)).toEqual({ userId: "usr_alice" });
  });

  it("does not attach or recover malformed subjects", () => {
    const actor = { id: "system", kind: "system" };
    expect(withPrivateAccountSubject(actor, undefined)).toBe(actor);
    expect(privateAccountSubject({ metadata: { accountSubject: { userId: 42 } } })).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import {
  describeIncompleteReceiverAuthority,
  receiverDirectEffect,
  validateReceiverAuthority,
} from "./receiverAuthorityDeclaration.js";

const complete = {
  authority: { principals: ["user"] },
  tier: { tier: "open", session: "family", rationale: "test" },
  access: { sensitivity: "read" },
  directEffect: { kind: "open" },
} as never;

describe("receiver authority declaration", () => {
  it("accepts a complete declaration", () => {
    expect(validateReceiverAuthority(complete)).toEqual({ ok: true });
  });

  it("names every missing field", () => {
    expect(validateReceiverAuthority({})).toEqual({
      ok: false,
      missing: ["authority", "tier", "access.sensitivity", "directEffect or capability"],
    });
  });

  it("accepts a capability in place of a direct effect and derives the host effect", () => {
    const method = { ...(complete as object), directEffect: undefined, capability: "notes.read" };
    expect(validateReceiverAuthority(method as never)).toEqual({ ok: true });
    expect(receiverDirectEffect(method as never)).toEqual({
      kind: "host-capability",
      capability: "notes.read",
      resource: { kind: "receiver-object" },
    });
  });

  it("requires a capability for requirement-form authority", () => {
    const method = {
      ...(complete as object),
      authority: { requirement: { kind: "capability", principal: "user", capability: "x" } },
    };
    expect(validateReceiverAuthority(method as never)).toEqual({
      ok: false,
      missing: ["capability (requirement-form authority binds a method capability)"],
    });
  });

  it("requires a capability only when a code principal is bound to a source", () => {
    const method = { ...(complete as object), authority: { principals: ["code"] } } as never;
    expect(validateReceiverAuthority(method)).toEqual({ ok: true });
    expect(validateReceiverAuthority(method, { codeSourceBound: true })).toEqual({
      ok: false,
      missing: ["capability (binds the code-source relationship of a code principal)"],
    });
  });

  it("describes all offenders with both fixes", () => {
    const message = describeIncompleteReceiverAuthority([
      { label: "A.one", missing: ["tier"] },
      { label: "A.two", missing: ["authority"] },
    ]);
    expect(message).toContain("A.one: missing tier");
    expect(message).toContain("A.two: missing authority");
    expect(message).toContain("createReceiverRpcMethods");
    expect(message).toContain("directEffect/capability");
  });
});

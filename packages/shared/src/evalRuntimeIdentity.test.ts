import { describe, expect, it } from "vitest";
import {
  evalHostObjectKeyOf,
  evalRuntimeId,
  isEvalHostRecord,
  isEvalHostRuntimeId,
} from "./evalRuntimeIdentity.js";

describe("evalRuntimeId", () => {
  it("derives a stable identity from both owner and scope", () => {
    const first = evalRuntimeId("session:perf", "default");
    expect(first).toMatch(/^do:workers\/session:SessionDO:[a-f0-9]{40}$/);
    expect(evalRuntimeId("session:perf", "default")).toBe(first);
    expect(evalRuntimeId("session:other", "default")).not.toBe(first);
    expect(evalRuntimeId("session:perf", "other")).not.toBe(first);
  });

  it("recognises its host entity by runtime id and by record, and nothing else", () => {
    const id = evalRuntimeId("panel:1", "default");
    expect(isEvalHostRuntimeId(id)).toBe(true);
    expect(evalHostObjectKeyOf(id)).toMatch(/^[a-f0-9]{40}$/);
    expect(isEvalHostRuntimeId("do:workers/other:SessionDO:abc")).toBe(false);
    expect(evalHostObjectKeyOf("do:vibestudio/internal:EvalDO:abc")).toBeNull();
    const record = { kind: "do", className: "SessionDO", source: { repoPath: "workers/session" } };
    expect(isEvalHostRecord(record)).toBe(true);
    expect(isEvalHostRecord({ ...record, className: "EvalDO" })).toBe(false);
    expect(isEvalHostRecord({ ...record, source: { repoPath: "vibestudio/internal" } })).toBe(
      false
    );
  });
});

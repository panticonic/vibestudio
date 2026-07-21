import { describe, expect, it } from "vitest";
import type { AuthenticatedCaller } from "@vibestudio/rpc";
import { EvalDO } from "./evalDO.js";
import { WebhookStoreDO } from "./webhookStoreDO.js";
import { WorkspaceDO } from "./workspaceDO.js";

type InboundGuard = (caller: AuthenticatedCaller | null, kind: "call" | "event") => void;

const caller = (callerKind: AuthenticatedCaller["callerKind"]): AuthenticatedCaller => ({
  callerId: `${callerKind}:test`,
  callerKind,
});

function guardOf(prototype: object): InboundGuard {
  const guard = (prototype as unknown as { assertInboundAllowed?: InboundGuard })
    .assertInboundAllowed;
  if (!guard) throw new Error("Expected an internal DO receiver guard");
  return guard;
}

describe.each([
  ["EvalDO", EvalDO.prototype, /eval: EvalDO is server-only/],
  ["WebhookStoreDO", WebhookStoreDO.prototype, /WebhookStoreDO is server-only/],
  ["WorkspaceDO", WorkspaceDO.prototype, /WorkspaceDO is server-only/],
] as const)("%s receiver authority", (_name, prototype, refusal) => {
  const guard = guardOf(prototype);

  it("allows server-dispatched method calls", () => {
    expect(() => guard.call(prototype, caller("server"), "call")).not.toThrow();
  });

  it("refuses direct code and unattributed method calls", () => {
    expect(() => guard.call(prototype, caller("do"), "call")).toThrow(refusal);
    expect(() => guard.call(prototype, caller("panel"), "call")).toThrow(refusal);
    expect(() => guard.call(prototype, null, "call")).toThrow(refusal);
  });

  it("keeps opt-in event delivery separate from method authority", () => {
    expect(() => guard.call(prototype, caller("do"), "event")).not.toThrow();
  });
});

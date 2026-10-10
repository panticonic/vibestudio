import { describe, expect, it } from "vitest";
import { rpcCausalParentSchema } from "./rpcCausality.js";
import { vcsTrajectoryInvocationRefSchema } from "./vcs.js";
import { gadWireMethods } from "./workspaceSource.js";

const coordinate = {
  kind: "trajectory-invocation" as const,
  logId: "channel:exact",
  head: "main",
  invocationId: "invocation:exact",
};
const locator = {
  owner: { runtimeId: "do:worker:Agent:exact", authoritySessionId: "authority:exact" },
  task: { conversationId: 0, taskId: 1 },
  operation: { kind: "tool" as const, assistantEntryId: 2, callId: "tool:exact" },
};
function acknowledgement(parent: unknown) {
  return {
    kind: "host-content",
    request: {
      kind: "prepare-semantic-content",
      operation: "edit",
      input: {},
      ingress: { causalParent: parent },
      observed: [],
      blobs: [],
    },
  };
}

describe("native causal locator propagation", () => {
  it.each([coordinate, { ...coordinate, nativeInvocation: locator }])(
    "preserves original coordinates and exact optional task locator through semantic acknowledgements",
    (parent) => {
      expect(rpcCausalParentSchema.parse(parent)).toEqual(parent);
      expect(vcsTrajectoryInvocationRefSchema.parse(parent)).toEqual(parent);
      const response = acknowledgement(parent);
      expect(gadWireMethods.vcsEdit.returns!.parse(response)).toEqual(response);
      expect(gadWireMethods.vcsSemanticHostReadAck.returns.parse(response)).toEqual(response);
      const args = [{ acknowledgement: { request: response.request, contentHashes: [] } }];
      expect(gadWireMethods.vcsSemanticContentAck.args.parse(args)).toEqual(args);
    },
  );

  it.each([
    { ...locator, task: { ...locator.task, taskId: 0 } },
    { ...locator, owner: { ...locator.owner, inventedAuthority: "bypass" } },
    { ...locator, operation: { ...locator.operation, assistantEntryId: null } },
  ])("rejects malformed locator rather than stripping causal authority", (invalid) => {
    const parent = { ...coordinate, nativeInvocation: invalid };
    expect(() => rpcCausalParentSchema.parse(parent)).toThrow();
    expect(() => vcsTrajectoryInvocationRefSchema.parse(parent)).toThrow();
    expect(() => gadWireMethods.vcsEdit.returns!.parse(acknowledgement(parent))).toThrow();
  });
});

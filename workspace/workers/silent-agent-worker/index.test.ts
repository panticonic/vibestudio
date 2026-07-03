import { describe, expect, it } from "vitest";
import { createTestDO } from "@workspace/runtime/worker/test-utils";
import { defaultPolicies, type AgentState } from "@workspace/agent-loop";

import { SilentAgentWorker } from "./index.js";

class TestSilentAgentWorker extends SilentAgentWorker {
  publishPolicy(): "all" | "turn-final" | "say-only" | undefined {
    return this.getPublishPolicy("ch-1");
  }
}

describe("SilentAgentWorker", () => {
  it("selects the say-only publish policy", async () => {
    const { instance } = await createTestDO(TestSilentAgentWorker);
    const worker = instance as TestSilentAgentWorker;
    expect(worker.publishPolicy()).toBe("say-only");
  });

  it("suppresses normal trajectory chatter under say-only, keeping turn boundaries", () => {
    // The silent agent migrates onto the config-level `publishPolicy` StepPolicy
    // (WS-4). With config.publishPolicy = "say-only" it flips `publish` off for
    // everything but turn open/close — the old `silentPolicy()` behavior.
    const policy = defaultPolicies().find((p) => p.name === "publish-policy");
    expect(policy).toBeDefined();
    const state = { config: { publishPolicy: "say-only" } } as unknown as AgentState;
    const items = [
      { envelopeId: "a", payloadKind: "turn.opened" as const, payload: {}, publish: true },
      { envelopeId: "b", payloadKind: "message.completed" as const, payload: {}, publish: true },
      { envelopeId: "c", payloadKind: "turn.closed" as const, payload: {}, publish: true },
    ];
    const filtered = policy!.transformAppend!({ state, items });
    expect(filtered.map((item) => [item.payloadKind, item.publish])).toEqual([
      ["turn.opened", true],
      ["message.completed", false],
      ["turn.closed", true],
    ]);
  });
});

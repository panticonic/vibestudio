import { describe, expect, it } from "vitest";
import { createTestDO } from "@workspace/runtime/worker/test-utils";
import type { StepPolicy } from "@workspace/agent-loop";

import { SilentAgentWorker } from "./index.js";

class TestSilentAgentWorker extends SilentAgentWorker {
  policies(): StepPolicy[] {
    return this.getStepPolicies("ch-1");
  }
}

describe("SilentAgentWorker", () => {
  it("publishes turn state while suppressing normal trajectory chatter", async () => {
    const { instance } = await createTestDO(TestSilentAgentWorker);
    const worker = instance as TestSilentAgentWorker;
    const policies = worker.policies();
    const silent = policies.find((policy) => policy.name === "silent");
    expect(silent).toBeDefined();

    const items = [
      { envelopeId: "a", payloadKind: "turn.opened" as const, payload: {}, publish: true },
      { envelopeId: "b", payloadKind: "message.completed" as const, payload: {}, publish: true },
      { envelopeId: "c", payloadKind: "turn.closed" as const, payload: {}, publish: true },
    ];
    const filtered = silent!.transformAppend!({ state: {} as never, items });
    expect(filtered.map((item) => [item.payloadKind, item.publish])).toEqual([
      ["turn.opened", true],
      ["message.completed", false],
      ["turn.closed", true],
    ]);
  });
});

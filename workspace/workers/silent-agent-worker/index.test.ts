import { describe, expect, it } from "vitest";
import { createTestDO } from "@workspace/runtime/worker/test-utils";
import type { PiRunnerOptions } from "@workspace/harness";

import { SilentAgentWorker } from "./index.js";

class TestSilentAgentWorker extends SilentAgentWorker {
  makeRunner(opts: PiRunnerOptions) {
    return this.createRunner("ch-1", opts);
  }
}

describe("SilentAgentWorker", () => {
  it("publishes turn state while suppressing normal trajectory chatter", async () => {
    const { instance } = await createTestDO(TestSilentAgentWorker);
    const worker = instance as TestSilentAgentWorker;
    const runner = worker.makeRunner({} as PiRunnerOptions) as unknown as {
      options: Required<Pick<PiRunnerOptions, "publicationPolicy">>;
    };
    const policy = runner.options.publicationPolicy;

    expect(
      policy?.({
        event: { kind: "turn.opened" } as never,
        publishToChannel: true,
      })
    ).toBe(true);
    expect(
      policy?.({
        event: { kind: "turn.closed" } as never,
        publishToChannel: true,
      })
    ).toBe(true);
    expect(
      policy?.({
        event: { kind: "message.completed" } as never,
        publishToChannel: true,
      })
    ).toBe(false);
  });
});

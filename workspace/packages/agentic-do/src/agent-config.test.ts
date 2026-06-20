/**
 * Per-agent config: seeding from creation stateArgs (sanitized to the 7 known
 * settings), respondFrom handle→id resolution, and multi-channel invalidation
 * when config changes (config is per-AGENT, so a change applies to every channel).
 */
import { describe, expect, it, vi } from "vitest";
import { createTestDO } from "@workspace/runtime/worker/test-utils";
import type { ParticipantDescriptor } from "@workspace/harness";
import { AgentVesselBase, resolveRespondFromHandles } from "./agent-vessel.js";

/** Minimal concrete vessel + test handles onto the protected managers. */
class TestAgentVessel extends AgentVesselBase {
  protected getParticipantInfo(): ParticipantDescriptor {
    return { type: "agent", name: "Test", handle: "test" } as ParticipantDescriptor;
  }
  driverForTest(): { dropLoop: (channelId: string) => void } {
    return this.driver as unknown as { dropLoop: (channelId: string) => void };
  }
  subscriptionsForTest(): { listChannelIds: () => string[] } {
    return this.subscriptions as unknown as { listChannelIds: () => string[] };
  }
}

async function makeVessel(env?: Record<string, unknown>): Promise<TestAgentVessel> {
  const { instance } = await createTestDO(TestAgentVessel, { __objectKey: "agent-key", ...env });
  return instance;
}

describe("resolveRespondFromHandles", () => {
  it("maps handles to this channel's participant ids and keeps non-matches as-is", () => {
    const resolved = resolveRespondFromHandles(
      ["@alice", "p-bob", "@nobody"],
      [
        { participantId: "p-alice", metadata: { handle: "@alice" } },
        { participantId: "p-bob", metadata: {} },
      ]
    );
    expect(resolved).toEqual(["p-alice", "p-bob", "@nobody"]);
  });

  it("is a no-op on an empty allowlist", () => {
    expect(resolveRespondFromHandles([], [{ participantId: "p", metadata: { handle: "@p" } }])).toEqual([]);
  });
});

describe("per-agent settings seeding from STATE_ARGS.agentConfig", () => {
  it("seeds the valid settings and ignores invalid/unknown/presentation keys", async () => {
    const vessel = await makeVessel({
      STATE_ARGS: {
        agentConfig: {
          model: "openai:gpt-5.3",
          thinkingLevel: "high",
          approvalLevel: 1,
          // invalid + non-settings keys must be dropped by the sanitizer:
          thinkingLevelTypo: "ultra",
          approvalLevelBad: 99,
          handle: "presentation-not-a-setting",
          bogus: { nested: true },
        },
      },
    });

    const settings = vessel.getAgentSettings();
    expect(settings.model).toBe("openai:gpt-5.3");
    expect(settings.thinkingLevel).toBe("high");
    expect(settings.approvalLevel).toBe(1);
    // getAgentSettings only ever returns the 7 known settings — never presentation/junk.
    expect(settings).not.toHaveProperty("handle");
    expect(settings).not.toHaveProperty("bogus");
  });

  it("falls back to defaults when no creation config is present", async () => {
    const vessel = await makeVessel();
    const settings = vessel.getAgentSettings();
    expect(typeof settings.model).toBe("string");
    expect(settings.model.length).toBeGreaterThan(0);
    expect([0, 1, 2]).toContain(settings.approvalLevel);
  });

  it("rejects an invalid model in the seed (falls back to the default model)", async () => {
    const seeded = await makeVessel({ STATE_ARGS: { agentConfig: { model: "openai:gpt-5.3" } } });
    const bad = await makeVessel({ STATE_ARGS: { agentConfig: { model: 42 } } });
    expect(seeded.getAgentSettings().model).toBe("openai:gpt-5.3");
    expect(bad.getAgentSettings().model).not.toBe(42);
    expect(typeof bad.getAgentSettings().model).toBe("string");
  });
});

describe("per-agent config invalidation spans all the agent's channels", () => {
  it("dropping config drops the cached loop for EVERY subscribed channel", async () => {
    const vessel = await makeVessel();
    vi.spyOn(vessel.subscriptionsForTest(), "listChannelIds").mockReturnValue(["ch-a", "ch-b"]);
    const dropLoop = vi.spyOn(vessel.driverForTest(), "dropLoop");

    vessel.configureAgent({ model: "anthropic:claude-sonnet-4-6" });

    expect(dropLoop).toHaveBeenCalledWith("ch-a");
    expect(dropLoop).toHaveBeenCalledWith("ch-b");
  });
});

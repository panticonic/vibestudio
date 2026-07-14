import { describe, expect, it } from "vitest";
import { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import type { EntityRecord } from "@vibestudio/shared/runtime/entitySpec";

import { resolveCodeIdentity } from "./principalIdentity.js";

function makeDoRecord(id: string, repoPath: string, executionDigest: string): EntityRecord {
  return {
    id,
    kind: "do",
    source: { repoPath },
    activeExecutionDigest: executionDigest,
    contextId: "ctx-chat",
    key: id,
    createdAt: Date.now(),
    status: "active",
    cleanupComplete: true,
  };
}

describe("resolveCodeIdentity", () => {
  it("resolves source identity from a concrete DO entity row", () => {
    const cache = new EntityCache();
    cache._onActivate(
      makeDoRecord(
        "do:workers/agent-worker:AiChatWorker:ai-chat-96322794",
        "workers/agent-worker",
        "hash-1"
      )
    );

    expect(
      resolveCodeIdentity(cache, "do:workers/agent-worker:AiChatWorker:ai-chat-96322794", () => [
        { capability: "service:*", resource: { kind: "prefix", prefix: "" } },
      ])
    ).toEqual({
      callerId: "do:workers/agent-worker:AiChatWorker:ai-chat-96322794",
      callerKind: "do",
      repoPath: "workers/agent-worker",
      executionDigest: "hash-1",
      requested: [{ capability: "service:*", resource: { kind: "prefix", prefix: "" } }],
    });
  });

  it("returns null when no entity record is registered for the caller", () => {
    const cache = new EntityCache();

    expect(
      resolveCodeIdentity(cache, "do:workers/agent-worker:AiChatWorker:ai-chat-96322794", () => [])
    ).toBeNull();
  });
});

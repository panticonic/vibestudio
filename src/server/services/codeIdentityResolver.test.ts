import { describe, expect, it } from "vitest";

import { CodeIdentityResolver } from "./codeIdentityResolver.js";

describe("CodeIdentityResolver", () => {
  it("resolves concrete DO caller identities through their registered service identity", () => {
    const resolver = new CodeIdentityResolver();
    resolver.upsertCallerIdentity({
      callerId: "do-service:workers/agent-worker:AiChatWorker",
      callerKind: "worker",
      repoPath: "workers/agent-worker",
      effectiveVersion: "hash-1",
    });

    expect(
      resolver.resolveByCallerId("do:workers/agent-worker:AiChatWorker:ai-chat-96322794")
    ).toEqual({
      callerId: "do:workers/agent-worker:AiChatWorker:ai-chat-96322794",
      callerKind: "worker",
      repoPath: "workers/agent-worker",
      effectiveVersion: "hash-1",
    });
  });

  it("does not resolve concrete DO callers without a registered service identity", () => {
    const resolver = new CodeIdentityResolver();

    expect(
      resolver.resolveByCallerId("do:workers/agent-worker:AiChatWorker:ai-chat-96322794")
    ).toBeNull();
  });
});

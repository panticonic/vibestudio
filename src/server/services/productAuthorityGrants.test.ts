import { describe, expect, it } from "vitest";
import { productAuthorityGrants } from "./productAuthorityGrants.js";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";

const GAD_CAPABILITY = "workspace-service:gad.workspace";

describe("product bootstrap authority", () => {
  it("admits an authenticated trusted user at gated—but never critical—tiers", () => {
    const caller = createVerifiedCaller("shell:device", "shell");
    const base = {
      caller,
      principals: { user: "user:alice" as const },
      capability: "service:workspace.hostTargets.launch",
      resourceKey: "service:workspace.hostTargets.launch",
      sessionId: "shell:device",
      now: 1,
    };

    expect(productAuthorityGrants({ ...base, tier: "gated" })).toEqual([
      expect.objectContaining({ subject: "user:alice", effect: "allow" }),
    ]);
    expect(productAuthorityGrants({ ...base, tier: "critical" })).toEqual([]);
  });

  it("does not turn a reviewed catalog row into standing gated or critical consent", () => {
    const capability = "service:credentials.resolveCredential";
    const digest = "a".repeat(64);
    const caller = createVerifiedCaller("do:workers/agent-worker:AiChatWorker:test", "do", {
      callerId: "do:workers/agent-worker:AiChatWorker:test",
      callerKind: "do",
      repoPath: "workers/agent-worker",
      effectiveVersion: "ev-test",
      executionDigest: digest,
      requested: [{ capability, resource: { kind: "exact", key: capability } }],
      evalCeilings: [],
    });
    const base = {
      caller,
      principals: { code: `code:workers/agent-worker@${digest}` as const },
      capability,
      resourceKey: capability,
      sessionId: "session-test",
      now: 1,
    };

    expect(productAuthorityGrants({ ...base, tier: "gated" })).toEqual([]);
    expect(productAuthorityGrants({ ...base, tier: "critical" })).toEqual([]);
  });

  it("retains reviewed code admission only for the explicit direct-RPC bridge", () => {
    const capability = "rpc:callMethod";
    const digest = "a".repeat(64);
    const caller = createVerifiedCaller("do:workers/agent-worker:AiChatWorker:test", "do", {
      callerId: "do:workers/agent-worker:AiChatWorker:test",
      callerKind: "do",
      repoPath: "workers/agent-worker",
      effectiveVersion: "ev-test",
      executionDigest: digest,
      requested: [{ capability, resource: { kind: "prefix", prefix: "" } }],
      evalCeilings: [],
    });

    expect(
      productAuthorityGrants({
        caller,
        principals: { code: `code:workers/agent-worker@${digest}` },
        capability,
        resourceKey: "do:workers/pubsub-channel:PubSubChannel:test",
        sessionId: "session-test",
        now: 1,
        grantCode: true,
      })
    ).toEqual([
      expect.objectContaining({
        subject: `code:workers/agent-worker@${digest}`,
        capability,
        provenance: "sealed-manifest-admission-v1",
      }),
    ]);
  });

  it("does not admit a direct capability absent from the exact sealed manifest", () => {
    const digest = "b".repeat(64);
    const caller = createVerifiedCaller("do:workers/example:Example:test", "do", {
      callerId: "do:workers/example:Example:test",
      callerKind: "do",
      repoPath: "workers/example",
      effectiveVersion: "ev-test",
      executionDigest: digest,
      requested: [],
      evalCeilings: [],
    });
    expect(
      productAuthorityGrants({
        caller,
        principals: { code: `code:workers/example@${digest}` },
        capability: GAD_CAPABILITY,
        resourceKey: "do:vibestudio/internal:GadWorkspaceDO:workspace-semantic-control-plane",
        sessionId: "session-test",
        now: 1,
      })
    ).toEqual([]);
  });
});

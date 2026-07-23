import { describe, expect, it } from "vitest";
import { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import type { EntityRecord } from "@vibestudio/shared/runtime/entitySpec";

import { resolveCodeIdentity } from "./principalIdentity.js";

function makeDoRecord(id: string, repoPath: string, effectiveVersion: string): EntityRecord {
  return {
    id,
    kind: "do",
    source: { repoPath, effectiveVersion },
    contextId: "ctx-chat",
    key: id,
    createdAt: Date.now(),
    status: "active",
    cleanupComplete: true,
    activeBuildKey: "b".repeat(64),
    activeExecutionDigest: "a".repeat(64),
    activeAuthority: {
      requests: [
        {
          capability: "service:workspace-state.alarmClear",
          resource: { kind: "exact", key: "workspace:test" },
          tier: "gated",
          evidence: "exact",
        },
      ],
      evalCeilings: [],
    },
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
      resolveCodeIdentity(cache, "do:workers/agent-worker:AiChatWorker:ai-chat-96322794")
    ).toEqual({
      callerId: "do:workers/agent-worker:AiChatWorker:ai-chat-96322794",
      callerKind: "do",
      repoPath: "workers/agent-worker",
      effectiveVersion: "hash-1",
      executionDigest: "a".repeat(64),
      requested: [
        {
          capability: "service:workspace-state.alarmClear",
          resource: { kind: "exact", key: "workspace:test" },
          tier: "gated",
          evidence: "exact",
        },
      ],
      evalCeilings: [],
    });
  });

  it("returns null when no entity record is registered for the caller", () => {
    const cache = new EntityCache();

    expect(
      resolveCodeIdentity(cache, "do:workers/agent-worker:AiChatWorker:ai-chat-96322794")
    ).toBeNull();
  });

  it("fails closed when an entity has no sealed execution identity", () => {
    const cache = new EntityCache();
    const record = makeDoRecord(
      "do:workers/agent-worker:AiChatWorker:missing",
      "workers/agent-worker",
      "hash-1"
    );
    delete record.activeExecutionDigest;
    cache._onActivate(record);

    expect(resolveCodeIdentity(cache, record.id)).toBeNull();
  });

  it("fails closed when an entity has no selected immutable build", () => {
    const cache = new EntityCache();
    const record = makeDoRecord(
      "do:workers/agent-worker:AiChatWorker:missing",
      "workers/agent-worker",
      "hash-1"
    );
    delete record.activeBuildKey;
    cache._onActivate(record);

    expect(resolveCodeIdentity(cache, record.id)).toBeNull();
  });

  it("fails closed when an entity has no sealed authority manifest", () => {
    const cache = new EntityCache();
    const record = makeDoRecord(
      "do:workers/agent-worker:AiChatWorker:missing",
      "workers/agent-worker",
      "hash-1"
    );
    delete record.activeAuthority;
    cache._onActivate(record);

    expect(resolveCodeIdentity(cache, record.id)).toBeNull();
  });

  it("projects only the owner's reviewed eval ceiling onto a host-created EvalDO", () => {
    const cache = new EntityCache();
    const owner = makeDoRecord(
      "do:workers/agent-worker:AiChatWorker:owner",
      "workers/agent-worker",
      "owner-ev"
    );
    owner.activeAuthority = {
      requests: [],
      evalCeilings: [
        {
          audience: "eval",
          purpose: "agentic-code-execution",
          capabilities: [
            {
              capability: "rpc:subscribeChannel",
              resource: { kind: "prefix", prefix: "" },
              tier: "gated",
              evidence: "intentional-broad",
            },
          ],
        },
        {
          audience: "eval",
          purpose: "tool-eval",
          capabilities: [
            {
              capability: "service:fs.readFile",
              resource: { kind: "prefix", prefix: "" },
              tier: "gated",
              evidence: "intentional-broad",
            },
          ],
        },
      ],
    };
    cache._onActivate(owner);
    const evalId = "do:vibestudio/internal:EvalDO:eval-owner";
    cache._onActivate({
      id: evalId,
      kind: "do",
      source: { repoPath: "vibestudio/internal", effectiveVersion: "internal" },
      contextId: owner.contextId,
      className: "EvalDO",
      key: "eval-owner",
      parentId: owner.id,
      stateArgs: {
        ownerPrincipalId: owner.id,
        subKey: "system-tests",
        authorityCeilingPurpose: "agentic-code-execution",
      },
      createdAt: Date.now(),
      status: "active",
      cleanupComplete: true,
    });

    expect(resolveCodeIdentity(cache, evalId)).toEqual({
      callerId: evalId,
      callerKind: "do",
      repoPath: owner.source.repoPath,
      effectiveVersion: owner.source.effectiveVersion,
      executionDigest: owner.activeExecutionDigest,
      requested: [
        {
          capability: "rpc:subscribeChannel",
          resource: { kind: "prefix", prefix: "" },
          tier: "gated",
          evidence: "intentional-broad",
        },
      ],
      evalCeilings: [],
      evalOrigin: { ownerId: owner.id, purpose: "agentic-code-execution" },
    });
  });

  it("does not project eval authority across an unverified owner link or purpose", () => {
    const cache = new EntityCache();
    const owner = makeDoRecord(
      "do:workers/agent-worker:AiChatWorker:owner",
      "workers/agent-worker",
      "owner-ev"
    );
    owner.activeAuthority = {
      requests: [],
      evalCeilings: [
        {
          audience: "eval",
          purpose: "agentic-code-execution",
          capabilities: [
            {
              capability: "rpc:subscribeChannel",
              resource: { kind: "prefix", prefix: "" },
              tier: "gated",
              evidence: "intentional-broad",
            },
          ],
        },
      ],
    };
    cache._onActivate(owner);
    const evalId = "do:vibestudio/internal:EvalDO:forged";
    const evalRecord: EntityRecord = {
      id: evalId,
      kind: "do",
      source: { repoPath: "vibestudio/internal", effectiveVersion: "internal" },
      contextId: owner.contextId,
      className: "EvalDO",
      key: "forged",
      parentId: "do:workers/agent-worker:AiChatWorker:other",
      stateArgs: {
        ownerPrincipalId: owner.id,
        authorityCeilingPurpose: "agentic-code-execution",
      },
      createdAt: Date.now(),
      status: "active",
      cleanupComplete: true,
    };
    cache._onActivate(evalRecord);

    expect(resolveCodeIdentity(cache, evalId)).toBeNull();
    evalRecord.parentId = owner.id;
    evalRecord.stateArgs = {
      ownerPrincipalId: owner.id,
      authorityCeilingPurpose: "not-a-purpose",
    };
    cache._onActivate(evalRecord);
    expect(resolveCodeIdentity(cache, evalId)).toBeNull();
  });
});

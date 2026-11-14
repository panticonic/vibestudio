import { describe, expect, it } from "vitest";
import { EntityCache } from "@vibestudio/shared/runtime/entityCache";
import type { EntityRecord } from "@vibestudio/shared/runtime/entitySpec";

import { entityOfCodeIdentity, resolveCodeIdentity } from "./principalIdentity.js";

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
      provides: [],
      requests: [
        {
          capability: "service:workspace-state.alarmClear",
          resource: { kind: "exact", key: "workspace:test" },
          tier: "gated",
          evidence: "exact",
        },
      ],
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

  it("attributes a host-admitted session entity to its exact harness without inheriting requests", () => {
    const cache = new EntityCache();
    const owner = makeDoRecord(
      "do:workers/agent-worker:AiChatWorker:owner",
      "workers/agent-worker",
      "owner-ev"
    );
    owner.activeAuthority = { requests: [], provides: [] };
    cache._onActivate(owner);
    const evalId = "do:workers/session:SessionDO:eval-owner";
    cache._onActivate({
      id: evalId,
      kind: "do",
      source: { repoPath: "workers/session", effectiveVersion: "internal" },
      contextId: owner.contextId,
      className: "SessionDO",
      key: "eval-owner",
      parentId: owner.id,
      stateArgs: {
        ownerPrincipalId: owner.id,
        subKey: "system-tests",
        agentExecutionAdmission: { v: 1, ownerId: owner.id },
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
      requested: [],
      evalOrigin: { ownerId: owner.id },
    });
  });

  it("names the owner's entity for an owner with code, and the session entity for an inert owner (a CLI session)", () => {
    const cache = new EntityCache();
    const owner = makeDoRecord(
      "do:workers/agent-worker:AiChatWorker:owner",
      "workers/agent-worker",
      "owner-ev"
    );
    owner.activeAuthority = { requests: [], provides: [] };
    cache._onActivate(owner);
    const session = (id: string, key: string, ownerId: string) => {
      const record = makeDoRecord(id, "workers/session", "session-ev");
      record.key = key;
      record.className = "SessionDO";
      record.parentId = ownerId;
      record.stateArgs = {
        ownerPrincipalId: ownerId,
        agentExecutionAdmission: { v: 1, ownerId },
      };
      record.activeAuthority = { requests: [], provides: [] };
      record.activeExecutionDigest = "c".repeat(64);
      cache._onActivate(record);
      return record;
    };
    // The owner has code: the identity is the owner's, and so is the entity that holds its image.
    const mediated = session("do:workers/session:SessionDO:a", "a", owner.id);
    const ownerIdentity = resolveCodeIdentity(cache, mediated.id)!;
    expect(entityOfCodeIdentity(cache, ownerIdentity)?.id).toBe(owner.id);
    // The owner has none: the identity falls back to the session entity's own image but still names
    // the owner, and the entity is the session entity (it was the inert owner before, so the
    // CLI's eval found no sealed artifact).
    cache._onActivate({
      id: "session:default",
      kind: "session",
      source: { repoPath: "agent-cli", effectiveVersion: "" },
      contextId: owner.contextId,
      createdAt: Date.now(),
      status: "active",
      cleanupComplete: true,
    } as EntityRecord);
    const inert = session("do:workers/session:SessionDO:b", "b", "session:default");
    const inertIdentity = resolveCodeIdentity(cache, inert.id)!;
    expect(inertIdentity.evalOrigin).toEqual({ ownerId: "session:default" });
    expect(entityOfCodeIdentity(cache, inertIdentity)?.id).toBe(inert.id);
  });

  it("rejects a session entity without the exact host admission and owner link", () => {
    const cache = new EntityCache();
    const owner = makeDoRecord(
      "do:workers/agent-worker:AiChatWorker:owner",
      "workers/agent-worker",
      "owner-ev"
    );
    owner.activeAuthority = { requests: [], provides: [] };
    cache._onActivate(owner);
    const evalId = "do:workers/session:SessionDO:forged";
    const evalRecord: EntityRecord = {
      id: evalId,
      kind: "do",
      source: { repoPath: "workers/session", effectiveVersion: "internal" },
      contextId: owner.contextId,
      className: "SessionDO",
      key: "forged",
      parentId: "do:workers/agent-worker:AiChatWorker:other",
      stateArgs: {
        ownerPrincipalId: owner.id,
        agentExecutionAdmission: { v: 1, ownerId: owner.id },
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
      agentExecutionAdmission: { v: 2, ownerId: owner.id },
    };
    cache._onActivate(evalRecord);
    expect(resolveCodeIdentity(cache, evalId)).toBeNull();
  });
});

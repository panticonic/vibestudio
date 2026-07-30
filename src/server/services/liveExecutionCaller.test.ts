import type { AgentExecutionSessionFact, AgentExecutionTestPolicy } from "@vibestudio/rpc";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import type { EntityRecord } from "@vibestudio/shared/runtime/entitySpec";
import { describe, expect, it } from "vitest";
import {
  executionHarnessCodeIdentity,
  refineExecutionTestPolicy,
  resolveLiveExecutionCaller,
} from "./liveExecutionCaller.js";

const orchestratorPolicy: AgentExecutionTestPolicy = {
  policyId: "test:run-1",
  kind: "orchestrator",
};
const casePolicy: AgentExecutionTestPolicy = {
  policyId: "test:run-1:case:approval",
  kind: "case",
  orchestratorPolicyId: orchestratorPolicy.policyId,
  case: {
    testId: "approval",
    agent: {
      model: "openai-codex:gpt-5.3-codex-spark",
      approvalLevel: 2,
      fallback: "disabled",
    },
    authority: [],
    unexpectedPrompts: "fail",
  },
};

const registered = createVerifiedCaller("do:workers/agent:Agent:agent-1", "do", {
  callerId: "do:workers/agent:Agent:agent-1",
  callerKind: "do",
  repoPath: "workers/agent",
  effectiveVersion: "ev-1",
  executionDigest: "digest-1",
  requested: [],
});

const activeEntity = {
  id: registered.runtime.id,
  kind: "do",
  source: { repoPath: "workers/agent", effectiveVersion: "ev-1" },
  contextId: "ctx-case",
  className: "Agent",
  key: "agent-1",
  agentBinding: {
    entityId: "agent-1",
    contextId: "ctx-case",
    channelId: "channel-1",
  },
  status: "active",
  cleanupComplete: false,
  createdAt: 1,
} satisfies EntityRecord;

const executionSession = {
  v: 1,
  authoritySessionId: "authority-session-1",
  authoritySessionVersion: 1,
  workspaceId: "workspace-1",
  contextId: activeEntity.contextId,
  mode: "test",
  harness: {
    principal: "code:workers/system-test-runner@digest",
    repoPath: "workers/system-test-runner",
    effectiveVersion: "runner-ev",
  },
  eval: {
    runtimeId: registered.runtime.id,
    runId: "system-test-runner:run-1",
    authorityManifest: {
      mode: "adaptive",
      effects: "read-write",
      approvals: "prompt",
      requests: [],
      digest: "0".repeat(64),
    },
  },
  agentBinding: {
    entityId: activeEntity.agentBinding.entityId,
    channelId: activeEntity.agentBinding.channelId,
    bindingId: "binding-1",
  },
  ownerUser: "user:test-user",
  taskRef: "approval",
  causalParent: null,
  testPolicy: casePolicy,
  issuedAt: 1,
  expiresAt: Number.MAX_SAFE_INTEGER,
  nonce: "nonce-1",
} satisfies AgentExecutionSessionFact;

describe("live execution caller resolution", () => {
  it("joins a registered image to the current agent session and case policy", () => {
    expect(
      resolveLiveExecutionCaller({
        registered,
        activeEntity,
        executionSession,
        contextTestPolicy: orchestratorPolicy,
      })
    ).toMatchObject({
      runtime: registered.runtime,
      code: {
        callerId: registered.runtime.id,
        callerKind: "do",
        repoPath: executionSession.harness.repoPath,
        effectiveVersion: executionSession.harness.effectiveVersion,
        executionDigest: "digest",
        requested: [],
      },
      agentBinding: activeEntity.agentBinding,
      executionSession,
      testPolicy: casePolicy,
    });
  });

  it("rejects a malformed host harness principal", () => {
    expect(() =>
      executionHarnessCodeIdentity({
        runtime: registered.runtime,
        executionSession: {
          ...executionSession,
          harness: { ...executionSession.harness, principal: "code:workers/other@digest" },
        },
        residentCode: registered.code,
      })
    ).toThrow(/does not match its repository/);
  });

  it("projects current exact-version approval onto a long-lived egress caller", () => {
    const isCodeApproved = vi.fn(() => true);
    expect(
      resolveLiveExecutionCaller({
        registered,
        activeEntity,
        executionSession: null,
        contextTestPolicy: null,
        isCodeApproved,
      })
    ).toMatchObject({ codeApproved: true });
    expect(isCodeApproved).toHaveBeenCalledWith(registered.code);
  });

  it("does not invent code approval when the exact version is unapproved", () => {
    expect(
      resolveLiveExecutionCaller({
        registered,
        activeEntity,
        executionSession: null,
        contextTestPolicy: null,
        isCodeApproved: () => false,
      })
    ).not.toHaveProperty("codeApproved");
  });

  it("rejects a stale session whose live context no longer matches", () => {
    expect(
      resolveLiveExecutionCaller({
        registered,
        activeEntity: { ...activeEntity, contextId: "ctx-replaced" },
        executionSession,
        contextTestPolicy: casePolicy,
      })
    ).toBeNull();
  });

  it("rejects unrelated nested test policies", () => {
    expect(
      refineExecutionTestPolicy(casePolicy, {
        policyId: "test:other",
        kind: "orchestrator",
      })
    ).toBeNull();
  });
});

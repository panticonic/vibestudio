import type { ExecutionAdmissionFact, AgentExecutionTestPolicy } from "@vibestudio/rpc";
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
  v: 2,
  authoritySessionId: "authority-session-1",
  authoritySessionVersion: 1,
  admissionKey: "test:run-1",
  workspaceId: "workspace-1",
  contextId: activeEntity.contextId,
  mode: "test",
  executionImage: {
    principal: "code:workers/system-test-runner@runner-ev",
    repoPath: "workers/system-test-runner",
    ref: "state:runner",
    effectiveVersion: "runner-ev",
    executionDigest: "digest",
  },
  executor: {
    kind: "eval",
    runtimeId: registered.runtime.id,
    evalRunId: "system-test-runner:run-1",
    authorityManifest: {
      mode: "adaptive",
      effects: "read-write",
      approvals: "prompt",
      requests: [],
      digest: "0".repeat(64),
    },
  },
  parent: null,
  agentBinding: {
    entityId: activeEntity.agentBinding.entityId,
    channelId: activeEntity.agentBinding.channelId,
    bindingId: "binding-1",
  },
  ownerUser: "user:test-user",
  taskRef: "approval",
  taskAuthority: "task:approval",
  causalParent: null,
  testPolicy: casePolicy,
  issuedAt: 1,
  expiresAt: Number.MAX_SAFE_INTEGER,
  nonce: "nonce-1",
} satisfies ExecutionAdmissionFact;

describe("live execution caller resolution", () => {
  it("joins a registered image to the current agent session and case policy", () => {
    expect(
      resolveLiveExecutionCaller({
        registered,
        activeEntity,
        executionSession,
        contextTestPolicy: orchestratorPolicy,
        taskAuthority: executionSession.taskAuthority,
      })
    ).toMatchObject({
      runtime: registered.runtime,
      code: {
        callerId: registered.runtime.id,
        callerKind: "do",
        repoPath: executionSession.executionImage.repoPath,
        effectiveVersion: executionSession.executionImage.effectiveVersion,
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
          executionImage: {
            ...executionSession.executionImage,
            principal: "code:workers/other@runner-ev",
          },
        },
        residentCode: registered.code,
      })
    ).toThrow(/does not match its source identity/);
  });

  it("projects current exact-version approval onto a long-lived egress caller", () => {
    const isCodeApproved = vi.fn(() => true);
    expect(
      resolveLiveExecutionCaller({
        registered,
        activeEntity,
        executionSession: null,
        contextTestPolicy: null,
        taskAuthority: null,
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
        taskAuthority: null,
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
        taskAuthority: executionSession.taskAuthority,
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

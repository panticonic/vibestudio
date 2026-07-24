import { describe, expect, it } from "vitest";
import {
  declaredWorkspaceServiceActivationInput,
  requireActiveExecutionIdentity,
} from "./runtimeExecutionIdentity.js";

const SERVICE_PLAN = {
  source: "workers/model-settings",
  className: "ModelSettingsDO",
  key: "workspace-model-settings",
  contextId: "ctx-settings",
};

const PREPARED_SERVICE = {
  buildKey: "b".repeat(64),
  effectiveVersion: "ev-settings",
  executionDigest: "a".repeat(64),
  authorityRequests: [
    {
      capability: "service:credentials.listStoredCredentials",
      resource: { kind: "exact" as const, key: "workspace:test" },
      tier: "gated" as const,
      evidence: "exact" as const,
    },
  ],
};

describe("requireActiveExecutionIdentity", () => {
  it("projects the complete sealed build identity into entity activation fields", () => {
    expect(
      requireActiveExecutionIdentity({
        executionDigest: "a".repeat(64),
        authorityRequests: [
          {
            capability: "service:workspace-state.alarmClear",
            resource: { kind: "exact", key: "workspace:test" },
            tier: "gated",
            evidence: "exact",
          },
        ],
      })
    ).toEqual({
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
      },
    });
  });

  it.each([
    { executionDigest: undefined, authorityRequests: [] },
    { executionDigest: "effective-version", authorityRequests: [] },
    { executionDigest: "a".repeat(64), authorityRequests: undefined },
  ])("fails closed for an incomplete identity: %o", (prepared) => {
    expect(() => requireActiveExecutionIdentity(prepared)).toThrow();
  });
});

describe("declaredWorkspaceServiceActivationInput", () => {
  it("activates a newly resolved declared service as host-managed workspace infrastructure", () => {
    expect(
      declaredWorkspaceServiceActivationInput(SERVICE_PLAN, PREPARED_SERVICE, null, "system")
    ).toEqual({
      kind: "do",
      source: {
        repoPath: "workers/model-settings",
        effectiveVersion: "ev-settings",
      },
      contextId: "ctx-settings",
      activeBuildKey: "b".repeat(64),
      activeExecutionDigest: "a".repeat(64),
      activeAuthority: {
        requests: PREPARED_SERVICE.authorityRequests,
      },
      className: "ModelSettingsDO",
      key: "workspace-model-settings",
      ownerUserId: "system",
    });
  });

  it("preserves an existing entity's immutable owner and agent binding", () => {
    const agentBinding = {
      entityId: "worker:agents/claude:agent-1",
      contextId: "ctx-settings",
      channelId: "channel-1",
    };

    expect(
      declaredWorkspaceServiceActivationInput(
        SERVICE_PLAN,
        PREPARED_SERVICE,
        {
          source: {
            repoPath: SERVICE_PLAN.source,
            effectiveVersion: PREPARED_SERVICE.effectiveVersion,
          },
          contextId: SERVICE_PLAN.contextId,
          className: SERVICE_PLAN.className,
          key: SERVICE_PLAN.key,
          ownerUserId: "usr-original-owner",
          agentBinding,
        },
        "system"
      )
    ).toMatchObject({
      ownerUserId: "usr-original-owner",
      agentBinding,
    });
  });

  it("rejects pairing an existing effective version with a different prepared build", () => {
    expect(() =>
      declaredWorkspaceServiceActivationInput(
        SERVICE_PLAN,
        PREPARED_SERVICE,
        {
          source: { repoPath: SERVICE_PLAN.source, effectiveVersion: "ev-previous" },
          contextId: SERVICE_PLAN.contextId,
          className: SERVICE_PLAN.className,
          key: SERVICE_PLAN.key,
          ownerUserId: "system",
        },
        "system"
      )
    ).toThrow(/cannot mix effectiveVersion/);
  });

  it("rejects replacing a previously selected build while finishing activation", () => {
    expect(() =>
      declaredWorkspaceServiceActivationInput(
        SERVICE_PLAN,
        PREPARED_SERVICE,
        {
          source: {
            repoPath: SERVICE_PLAN.source,
            effectiveVersion: PREPARED_SERVICE.effectiveVersion,
          },
          contextId: SERVICE_PLAN.contextId,
          className: SERVICE_PLAN.className,
          key: SERVICE_PLAN.key,
          activeBuildKey: "c".repeat(64),
          ownerUserId: "system",
        },
        "system"
      )
    ).toThrow(/already bound to build/);
  });

  it("fails closed instead of claiming an existing unowned entity for the system subject", () => {
    expect(() =>
      declaredWorkspaceServiceActivationInput(
        SERVICE_PLAN,
        PREPARED_SERVICE,
        {
          source: {
            repoPath: SERVICE_PLAN.source,
            effectiveVersion: PREPARED_SERVICE.effectiveVersion,
          },
          contextId: SERVICE_PLAN.contextId,
          className: SERVICE_PLAN.className,
          key: SERVICE_PLAN.key,
        },
        "system"
      )
    ).toThrow(/refusing to synthesize ownership/);
  });
});

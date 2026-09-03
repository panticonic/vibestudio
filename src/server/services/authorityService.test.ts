import { describe, expect, it, vi } from "vitest";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import { createAuthorityService } from "./authorityService.js";
import { taskAuthorityPrincipal } from "./taskAuthorityRegistry.js";

describe("authorityService", () => {
  it("lists and resets rules by the workspace-qualified chat binding", async () => {
    const subject = taskAuthorityPrincipal({
      workspaceId: "workspace:one",
      contextId: "context:agent",
      channelId: "channel:task",
    });
    const revokeSubject = vi.fn((_subject: string) => 1);
    const service = createAuthorityService({
      dispatcher: {} as never,
      acquisitions: {} as never,
      workspaceId: "workspace:one",
      grants: {
        listActiveAuthorityGrants: () => [
          {
            id: "grant:one",
            effect: "allow",
            capability: "panel.inspect",
            resource: { kind: "exact", key: "panel:task-board" },
            subject,
            constraints: { lineageAtConsent: ["none"] },
            issuedBy: "user:alice",
            provenance: "acquisition",
            createdAt: 10,
            scope: "task",
          },
        ],
        revokeSubject,
        transaction: (work: () => unknown) => work(),
      } as never,
    });
    const ctx = {
      caller: createVerifiedCaller("panel:chat", "panel", null, null, {
        userId: "alice",
        handle: "alice",
      }),
    } as never;
    const input = { contextId: "context:agent", channelId: "channel:task" };

    await expect(service.handler(ctx, "listTaskRules", [input])).resolves.toEqual([
      {
        id: "grant:one",
        capability: "panel.inspect",
        action: expect.any(String),
        resource: "panel:task-board",
        decidedAt: 10,
      },
    ]);
    await expect(service.handler(ctx, "resetTaskRules", [input])).resolves.toEqual({
      revokedGrantCount: 1,
    });
    expect(revokeSubject).toHaveBeenCalledWith(subject);
  });

  it("resets every agent task subject stamped with the same chat and no other chat", async () => {
    const chatOne = "channel:shared-task";
    const firstSubject = taskAuthorityPrincipal({
      workspaceId: "workspace:one",
      contextId: "context:first-agent",
      channelId: chatOne,
    });
    const secondSubject = taskAuthorityPrincipal({
      workspaceId: "workspace:one",
      contextId: "context:second-agent",
      channelId: chatOne,
    });
    const otherSubject = taskAuthorityPrincipal({
      workspaceId: "workspace:one",
      contextId: "context:first-agent",
      channelId: "channel:other-task",
    });
    const active = [
      { id: "grant:first", subject: firstSubject, taskRef: chatOne },
      { id: "grant:second", subject: secondSubject, taskRef: chatOne },
      { id: "grant:other", subject: otherSubject, taskRef: "channel:other-task" },
    ].map(({ id, subject, taskRef }) => ({
      id,
      effect: "allow" as const,
      capability: "panel.inspect",
      resource: { kind: "exact" as const, key: "panel:task-board" },
      subject,
      constraints: { taskRef, lineageAtConsent: ["none"] },
      issuedBy: "user:alice" as const,
      provenance: "acquisition" as const,
      createdAt: 10,
      scope: "task" as const,
    }));
    const revokeSubject = vi.fn((_subject: string) => 1);
    const service = createAuthorityService({
      dispatcher: {} as never,
      acquisitions: {} as never,
      workspaceId: "workspace:one",
      grants: {
        listActiveAuthorityGrants: () => active,
        revokeSubject,
        transaction: (work: () => unknown) => work(),
      } as never,
    });
    const ctx = {
      caller: createVerifiedCaller("panel:chat", "panel", null, null, {
        userId: "alice",
        handle: "alice",
      }),
    } as never;
    const input = { contextId: "context:first-agent", channelId: chatOne };

    await expect(service.handler(ctx, "listTaskRules", [input])).resolves.toHaveLength(2);
    await expect(service.handler(ctx, "resetTaskRules", [input])).resolves.toEqual({
      revokedGrantCount: 2,
    });
    expect(new Set(revokeSubject.mock.calls.map(([subject]) => subject))).toEqual(
      new Set([firstSubject, secondSubject])
    );
    expect(revokeSubject).not.toHaveBeenCalledWith(otherSubject);
  });

  it("forwards the inbound cancellation signal to an authority wait", async () => {
    const signal = new AbortController().signal;
    const awaitDecision = vi.fn(async () => ({ state: "closed" as const }));
    const service = createAuthorityService({
      dispatcher: { preflightAuthority: vi.fn() } as never,
      acquisitions: { awaitDecision } as never,
    });

    await expect(
      service.handler(
        { caller: createVerifiedCaller("agent:1", "agent"), signal },
        "awaitDecision",
        [{ acquisitionId: "acq:1" }]
      )
    ).resolves.toEqual({ state: "closed" });
    expect(awaitDecision).toHaveBeenCalledWith({
      acquisitionId: "acq:1",
      ownerRuntimeId: "agent:1",
      signal,
    });
  });

  it("lets the durable controller retire authority only after live executions close", async () => {
    const subject = `mission:timer@${"a".repeat(64)}` as const;
    const hasLiveMissionSubject = vi.fn(() => true);
    const retireTargetSubject = vi.fn(() => ({ cancelledRequests: 2 }));
    const revokeSubject = vi.fn(() => 3);
    const service = createAuthorityService({
      dispatcher: {} as never,
      acquisitions: {
        targetSubject: () => ({
          authorityPlanDigest: "b".repeat(64),
          ownerUser: "user:alice",
          controllerRuntimeId: "do:missions",
          state: "active",
        }),
        retireTargetSubject,
      } as never,
      executionAdmissions: { hasLiveMissionSubject } as never,
      grants: { revokeSubject } as never,
    });
    const context = {
      caller: createVerifiedCaller("do:missions", "do"),
    } as never;
    await expect(
      service.handler(context, "retireTarget", [{ targetSubject: subject }])
    ).rejects.toMatchObject({ code: "EBUSY" });
    hasLiveMissionSubject.mockReturnValue(false);
    await expect(
      service.handler(context, "retireTarget", [{ targetSubject: subject }])
    ).resolves.toEqual({ cancelledRequestCount: 2, revokedGrantCount: 3 });
    expect(retireTargetSubject).toHaveBeenCalledWith(subject);
    expect(revokeSubject).toHaveBeenCalledWith(subject);
  });

  it("attributes target acquisition to the verified authorizing user across a code relay", async () => {
    const registerTargetSubject = vi.fn();
    const service = createAuthorityService({
      dispatcher: {} as never,
      acquisitions: {
        targetSubject: () => null,
        registerTargetSubject,
        targetRequestsFor: () => [],
      } as never,
      authorityPlans: {
        get: () => ({ leaves: [] }),
      } as never,
    });
    const context = {
      caller: createVerifiedCaller("do:workers/missions:MissionsDO:workspace", "do"),
      authorizingCaller: createVerifiedCaller("agent:launcher", "agent", undefined, null, {
        userId: "alice",
        handle: "alice",
      }),
    } as never;
    const subject = `mission:timer@${"a".repeat(64)}` as const;
    await expect(
      service.handler(context, "acquireForTarget", [
        { targetSubject: subject, authorityPlanDigest: "b".repeat(64) },
      ])
    ).resolves.toEqual({ requestIds: [], grantIds: [], denialIds: [] });
    expect(registerTargetSubject).toHaveBeenCalledWith(
      subject,
      "b".repeat(64),
      "user:alice",
      "do:workers/missions:MissionsDO:workspace"
    );
  });

  it("pre-acquires an immutable plan only for the caller's attested task", async () => {
    const requestTaskRulesForTarget = vi.fn();
    const task = `task:${"d".repeat(64)}` as const;
    const service = createAuthorityService({
      dispatcher: {} as never,
      acquisitions: {
        requestTaskRulesForTarget,
        targetRequestsFor: () => [],
      } as never,
      authorityPlans: {
        get: () => ({
          leaves: [
            {
              service: "notification",
              method: "showToUser",
              capability: "notification.show",
              capabilityDefinitionDigest: "c".repeat(64),
              resource: { kind: "exact", key: "user:alice" },
              tier: "gated",
              review: {
                action: "show a notification",
                domain: "people",
                verb: "act",
                declaredBy: "host:notification.showToUser",
              },
            },
          ],
        }),
      } as never,
    });
    const caller = {
      ...createVerifiedCaller("agent:launcher", "agent", undefined, null, {
        userId: "alice",
        handle: "alice",
      }),
      taskAuthority: task,
    };

    await expect(
      service.handler({ caller } as never, "acquireForCurrentTask", [
        { authorityPlanDigest: "b".repeat(64) },
      ])
    ).resolves.toEqual({ requestIds: [], grantIds: [], denialIds: [] });
    expect(requestTaskRulesForTarget).toHaveBeenCalledWith([
      expect.objectContaining({
        targetSubject: task,
        sourceUser: "user:alice",
        capability: "notification.show",
      }),
    ]);
  });

  it("replays acquisition from the durable target owner after the launching execution ends", async () => {
    const subject = `mission:timer@${"a".repeat(64)}` as const;
    const requestForTarget = vi.fn();
    const registerTargetSubject = vi.fn();
    const service = createAuthorityService({
      dispatcher: {} as never,
      acquisitions: {
        targetSubject: () => ({
          authorityPlanDigest: "b".repeat(64),
          ownerUser: "user:alice",
          controllerRuntimeId: "do:workers/missions:MissionsDO:workspace",
          state: "active",
        }),
        registerTargetSubject,
        requestForTarget,
        targetRequestsFor: () => [],
      } as never,
      authorityPlans: {
        get: () => ({
          leaves: [
            {
              service: "accounts",
              method: "connect",
              capability: "accounts.connect",
              capabilityDefinitionDigest: "c".repeat(64),
              resource: { kind: "exact", key: "provider:example" },
              tier: "gated",
              review: {
                action: "connect an account",
                domain: "accounts",
                verb: "manage",
                declaredBy: "host:accounts.connect",
              },
            },
          ],
        }),
      } as never,
    });

    await expect(
      service.handler(
        {
          caller: createVerifiedCaller(
            "do:workers/missions:MissionsDO:workspace",
            "do",
            undefined,
            null,
            { userId: "system", handle: "system" }
          ),
        } as never,
        "acquireForTarget",
        [{ targetSubject: subject, authorityPlanDigest: "b".repeat(64) }]
      )
    ).resolves.toEqual({ requestIds: [], grantIds: [], denialIds: [] });
    expect(registerTargetSubject).not.toHaveBeenCalled();
    expect(requestForTarget).toHaveBeenCalledWith(
      expect.objectContaining({ targetSubject: subject, sourceUser: "user:alice" })
    );
  });

  it("rejects target replay from code other than the registered controller", async () => {
    const service = createAuthorityService({
      dispatcher: {} as never,
      acquisitions: {
        targetSubject: () => ({
          authorityPlanDigest: "b".repeat(64),
          ownerUser: "user:alice",
          controllerRuntimeId: "do:workers/missions:MissionsDO:workspace",
          state: "active",
        }),
        targetRequestsFor: () => [],
      } as never,
      authorityPlans: { get: () => ({ leaves: [] }) } as never,
    });
    const subject = `mission:timer@${"a".repeat(64)}` as const;
    await expect(
      service.handler(
        { caller: createVerifiedCaller("do:unrelated:Worker:one", "do") } as never,
        "acquireForTarget",
        [{ targetSubject: subject, authorityPlanDigest: "b".repeat(64) }]
      )
    ).rejects.toThrow(/different controller/);
  });

  it("rejects execution admission from code other than the registered controller", async () => {
    const service = createAuthorityService({
      dispatcher: {} as never,
      acquisitions: {
        targetSubject: () => ({
          authorityPlanDigest: "b".repeat(64),
          ownerUser: "user:alice",
          controllerRuntimeId: "do:workers/missions:MissionsDO:workspace",
          state: "active",
        }),
      } as never,
      authorityPlans: {} as never,
      executionAdmissions: {} as never,
      workspaceId: "workspace:one",
      resolveCodeIdentity: () => null,
    });
    await expect(
      service.handler(
        { caller: createVerifiedCaller("do:unrelated:Worker:one", "do") } as never,
        "admitExecution",
        [
          {
            admissionKey: "mission:timer:run:one",
            contextId: "context:one",
            taskRef: "run:one",
            mission: {
              subject: `mission:timer@${"a".repeat(64)}`,
              missionId: "timer",
              revision: 1,
              revisionDigest: "a".repeat(64),
            },
            executionImage: {
              source: "workers/agent-worker",
              ref: `state:${"c".repeat(64)}`,
              effectiveVersion: "d".repeat(64),
              className: "AiChatWorker",
            },
            authorityPlanDigest: "b".repeat(64),
            executor: {
              kind: "agent-turn",
              runtimeId: "do:workers/agent-worker:AiChatWorker:timer",
              entityId: "do:workers/agent-worker:AiChatWorker:timer",
              channelId: "channel:one",
              turnId: "run:one",
            },
          },
        ]
      )
    ).rejects.toThrow(/different mission controller/);
  });
});

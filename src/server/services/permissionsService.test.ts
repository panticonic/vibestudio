import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import type { CredentialUseGrant } from "@vibestudio/credential-client/types";
import { CapabilityGrantStore } from "./capabilityGrantStore.js";
import { createPermissionsService } from "./permissionsService.js";

const statePaths: string[] = [];

afterEach(() => {
  for (const statePath of statePaths.splice(0)) {
    fs.rmSync(statePath, { recursive: true, force: true });
  }
});

function context() {
  return {
    caller: createVerifiedCaller("shell:test", "shell", null, null, {
      userId: "usr_123456789012345678901234",
      handle: "owner",
    }),
  };
}

function createHarness() {
  const statePath = fs.mkdtempSync(path.join(os.tmpdir(), "permissions-service-"));
  statePaths.push(statePath);
  const capabilityGrants = new CapabilityGrantStore({ statePath });
  const credentialGrants: Array<CredentialUseGrant & { credentialId: string }> = [];
  const interruptAgent = vi.fn(async () => undefined);
  const interruptAllAgents = vi.fn(async () => undefined);
  const closeAgentAcquisitions = vi.fn(() => 1);
  const closeAllAcquisitions = vi.fn(() => 2);
  const definition = createPermissionsService({
    capabilityGrants,
    credentialUseGrants: {
      list: (credentialId) =>
        credentialGrants
          .filter((grant) => grant.credentialId === credentialId)
          .map(({ credentialId: _credentialId, ...grant }) => grant),
      listAll: () => credentialGrants.map((grant) => ({ ...grant })),
      upsert: (credentialId, grant) => {
        credentialGrants.push({ credentialId, ...grant });
      },
      revoke: () => false,
      revokeForAgent: (agentId) => {
        let removed = 0;
        for (let index = credentialGrants.length - 1; index >= 0; index -= 1) {
          const grant = credentialGrants[index];
          if (grant?.scope === "agent" && grant.agentId === agentId) {
            credentialGrants.splice(index, 1);
            removed += 1;
          }
        }
        return removed;
      },
    },
    browserPermissions: {
      list: vi.fn(() => []),
      revokeById: vi.fn(() => false),
      idFor: vi.fn(() => "browser"),
    } as never,
    workspaceId: "workspace-test",
    pendingAcquisitionCount: () => 2,
    pendingAcquisitions: () => [
      {
        acquisitionId: "acq-1",
        ownerRuntimeId: "do:workers/agent-worker:assistant",
        capability: "external.open",
        resource: { kind: "origin", origin: "https://example.com" } as const,
        tier: "gated" as const,
        renderedAction: "Open https://example.com",
        requestedAt: 900,
        agentBindingId: "do:workers/agent-worker:assistant@context-1",
      },
      {
        acquisitionId: "acq-0",
        ownerRuntimeId: "panel:about/permissions",
        capability: "external.open",
        resource: { kind: "origin", origin: "https://example.org" } as const,
        tier: "critical" as const,
        renderedAction: "Open https://example.org",
        requestedAt: 100,
        agentBindingId: null,
      },
    ],
    activeAgentBindingCount: () => 1,
    interruptAgent,
    interruptAllAgents,
    closeAgentAcquisitions,
    closeAllAcquisitions,
  });
  return {
    capabilityGrants,
    credentialGrants,
    definition,
    interruptAgent,
    interruptAllAgents,
    closeAgentAcquisitions,
    closeAllAcquisitions,
  };
}

describe("permissions service", () => {
  it("explains every saved grant in human terms", async () => {
    const harness = createHarness();
    harness.capabilityGrants.issue({
      id: "grant-agent",
      effect: "allow",
      capability: "external.open",
      resource: { kind: "origin", origin: "https://example.com" },
      subject: "agent:do:workers/agent-worker:assistant@context-1",
      constraints: {
        agentBindingId: "do:workers/agent-worker:assistant@context-1",
        lineageAtConsent: ["none"],
      },
      issuedBy: "user:usr_123456789012345678901234",
      decidedBy: "user:usr_123456789012345678901234",
      decisionSurface: "card",
      provenance: "acquisition",
      scope: "agent",
      lastUsedAt: 100,
    });

    const grants = (await harness.definition.handler(context(), "list", [])) as Array<
      Record<string, unknown>
    >;

    expect(grants[0]).toMatchObject({
      why: expect.stringContaining("protected action"),
      approvedBy: "You",
      duration: expect.stringContaining("3 months"),
      revokeEffect: expect.stringContaining("active protected work"),
      lastUsedAt: 100,
    });
    harness.capabilityGrants.close();
  });

  it("lists what the waiting count counts, oldest first and in the screen's vocabulary", async () => {
    const harness = createHarness();

    const pending = (await harness.definition.handler(
      context(),
      "listPendingRequests",
      []
    )) as Array<Record<string, unknown>>;

    expect(pending.map((request) => request["acquisitionId"])).toEqual(["acq-0", "acq-1"]);
    expect(pending[0]).toMatchObject({
      tier: "critical",
      requesterLabel: "panel:about/permissions",
      domain: "sharing",
    });
    expect(pending[1]).toMatchObject({
      tier: "gated",
      // An agent request is named by the agent, not by its runtime id.
      requesterLabel: "Assistant",
      agentBindingId: "do:workers/agent-worker:assistant@context-1",
    });
    harness.capabilityGrants.close();
  });

  it("durably pauses an agent before cancelling its pending and active work", async () => {
    const harness = createHarness();
    const bindingId = "do:workers/agent-worker:assistant@context-1";

    await harness.definition.handler(context(), "updateAgentProfile", [
      { action: "pause-agent", bindingId },
    ]);

    expect(harness.capabilityGrants.isAgentPaused(bindingId)).toBe(true);
    expect(harness.closeAgentAcquisitions).toHaveBeenCalledWith(bindingId);
    expect(harness.interruptAgent).toHaveBeenCalledWith(bindingId, "The user paused this agent.");
    expect(
      harness.capabilityGrants.matchingLocks(bindingId, "external.open", "https://example.com")[0]
    ).toMatchObject({ level: "agent" });
    harness.capabilityGrants.close();
  });

  it("engages one workspace lock that closes every acquisition and interrupts every agent", async () => {
    const harness = createHarness();

    const status = await harness.definition.handler(context(), "setWorkspaceAuthorityLock", [
      { locked: true },
    ]);

    // The lock reports the decision it is, not just the state it left behind:
    // a reviewer coming back to this screen has to be able to see who engaged
    // it and when without going to a separate log.
    expect(status).toMatchObject({
      workspaceLocked: true,
      activeAgentCount: 1,
      pendingAcquisitionCount: 2,
      lockedBy: "You",
    });
    expect((status as { lockedAt?: number }).lockedAt).toBeTypeOf("number");
    expect(harness.closeAllAcquisitions).toHaveBeenCalledOnce();
    expect(harness.interruptAllAgents).toHaveBeenCalledOnce();
    expect(
      harness.capabilityGrants.matchingLocks(
        "any-agent@any-context",
        "external.open",
        "https://example.com"
      )[0]
    ).toMatchObject({ level: "workspace" });
    harness.capabilityGrants.close();
  });
});

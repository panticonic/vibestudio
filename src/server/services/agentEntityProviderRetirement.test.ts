import { describe, expect, it, vi } from "vitest";
import type { Credential } from "@vibestudio/credential-client/types";
import type { EntityRecord } from "@vibestudio/shared/runtime/entitySpec";
import { retireAgentEntityAtProviders } from "./agentEntityProviderRetirement.js";

const DARA = "usr_dara";

function human(id: string, overrides: Partial<Credential> = {}): Credential {
  return {
    id,
    actor: "human",
    owner: { sourceId: "/repo", sourceKind: "workspace", label: "/repo", userId: DARA },
    agentExchange: {
      tokenUrl: "https://auth.example.test/oauth/token",
      clientId: "vibestudio",
      retireUrl: "https://auth.example.test/oauth/agents/retire",
    },
    ...overrides,
  } as Credential;
}

function agentRecord(overrides: Partial<EntityRecord> = {}): EntityRecord {
  return {
    id: "agent-1",
    kind: "do",
    source: { repoPath: "workers/agent-worker", effectiveVersion: "v1" },
    className: "AiChatWorker",
    agentBinding: { entityId: "agent-1", contextId: "ctx", channelId: "chan" },
    ownerUserId: DARA,
    status: "retired",
    ...overrides,
  } as EntityRecord;
}

function deps(credentials: Credential[]) {
  return {
    credentialStore: { listUrlBound: vi.fn(async () => credentials) },
    credentialLifecycle: { retireAgentEntity: vi.fn(async () => undefined) },
    credentialUseGrantStore: { revokeForAgent: vi.fn(() => 1) },
  };
}

describe("retireAgentEntityAtProviders", () => {
  it("retires the entity at the owner's human credentials with a retire endpoint, and drops its agent grants", async () => {
    const d = deps([
      human("cred-dara"),
      human("cred-bob", {
        owner: { sourceId: "/repo", sourceKind: "workspace", label: "/repo", userId: "usr_bob" },
      }),
      human("cred-no-endpoint", {
        agentExchange: {
          tokenUrl: "https://auth.example.test/oauth/token",
          clientId: "vibestudio",
        },
      }),
      human("cred-revoked", { revokedAt: 5 }),
      human("cred-agent-actor", { actor: "agent" }),
    ]);

    await retireAgentEntityAtProviders(d as never, agentRecord());

    expect(d.credentialUseGrantStore.revokeForAgent).toHaveBeenCalledWith("agent-1");
    expect(d.credentialLifecycle.retireAgentEntity).toHaveBeenCalledTimes(1);
    expect(d.credentialLifecycle.retireAgentEntity).toHaveBeenCalledWith(
      expect.objectContaining({ id: "cred-dara" }),
      "agent-1"
    );
  });

  it("ignores entities that are not agents and entities with no owner", async () => {
    const d = deps([human("cred-dara")]);
    await retireAgentEntityAtProviders(d as never, agentRecord({ agentBinding: undefined }));
    await retireAgentEntityAtProviders(
      d as never,
      agentRecord({ agentBinding: { entityId: "someone-else", contextId: "c", channelId: "x" } })
    );
    expect(d.credentialLifecycle.retireAgentEntity).not.toHaveBeenCalled();
    expect(d.credentialUseGrantStore.revokeForAgent).not.toHaveBeenCalled();

    await retireAgentEntityAtProviders(d as never, agentRecord({ ownerUserId: undefined }));
    expect(d.credentialLifecycle.retireAgentEntity).not.toHaveBeenCalled();
  });

  it("tries every credential and propagates the failure so the cleanup is retried", async () => {
    const d = deps([human("a"), human("b")]);
    d.credentialLifecycle.retireAgentEntity
      .mockRejectedValueOnce(new Error("provider down"))
      .mockResolvedValueOnce(undefined);

    await expect(retireAgentEntityAtProviders(d as never, agentRecord())).rejects.toThrow(
      /could not be retired/
    );
    expect(d.credentialLifecycle.retireAgentEntity).toHaveBeenCalledTimes(2);
  });
});

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createVerifiedCaller } from "@vibestudio/shared/serviceDispatcher";
import type {
  EntityRecord,
  RuntimeResourceBindingInput,
} from "@vibestudio/shared/runtime/entitySpec";
import { CapabilityGrantStore } from "./capabilityGrantStore.js";
import {
  prepareRuntimeResourceBindings,
  revokeRuntimeResourceBindings,
} from "./runtimeResourceBindings.js";

const binding: RuntimeResourceBindingInput = {
  resource: { kind: "panel-slot", id: "slot-a" },
  capabilities: ["panel.inspect"],
  scope: { kind: "agent-channel", channelId: "channel-a" },
};

const record: EntityRecord = {
  id: "do:workers/agent-worker:AiChatWorker:agent-a",
  kind: "do",
  source: { repoPath: "workers/agent-worker", effectiveVersion: "ev-agent" },
  activeBuildKey: "b".repeat(64),
  activeExecutionDigest: "e".repeat(64),
  activeAuthority: {
    provides: [],
    serviceRequests: [],
    requests: ["panel.inspect", "context.boundary"].map((capability) => ({
      capability,
      resource: { kind: "prefix" as const, prefix: "" },
      tier: "gated" as const,
      evidence: "intentional-broad" as const,
    })),
  },
  contextId: "ctx-panel",
  className: "AiChatWorker",
  key: "agent-a",
  agentBinding: {
    entityId: "do:workers/agent-worker:AiChatWorker:agent-a",
    contextId: "ctx-panel",
    channelId: "channel-a",
  },
  createdAt: 1,
  status: "active",
  cleanupComplete: true,
};

describe("runtime resource bindings", () => {
  let statePath: string;
  let grantStore: CapabilityGrantStore;
  beforeEach(() => {
    statePath = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-resource-bindings-"));
    grantStore = new CapabilityGrantStore({ statePath });
  });
  afterEach(() => {
    grantStore.close();
    fs.rmSync(statePath, { recursive: true, force: true });
  });

  const caller = createVerifiedCaller("app:apps/shell:main", "app", null, null, {
    userId: "user-a",
    handle: "alice",
  });

  it("binds an ordinary panel to the exact standard agent without prompting", async () => {
    const confirmPrivilegedPanel = vi.fn(async () => true);
    const prepared = await prepareRuntimeResourceBindings(
      {
        grantStore,
        resolvePanel: async () => ({ source: "panels/dashboard", contextId: "ctx-panel" }),
        confirmPrivilegedPanel,
      },
      { bindings: [binding], initiatingCaller: caller }
    );
    expect(prepared.contextId).toBe("ctx-panel");
    const grants = await prepared.bind(record);

    expect(confirmPrivilegedPanel).not.toHaveBeenCalled();
    expect(grants).toHaveLength(2);
    expect(grants).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subject: "code:workers/agent-worker@ev-agent",
          capability: "panel.inspect",
          constraints: expect.objectContaining({ sessionId: "channel-a" }),
        }),
        expect.objectContaining({ capability: "context.boundary" }),
      ])
    );

    expect(revokeRuntimeResourceBindings(grantStore, record.id)).toBe(2);
    expect(grantStore.listActiveAuthorityGrants()).toEqual([]);
  });

  it("requires an explicit decision only for a privileged panel", async () => {
    const confirmPrivilegedPanel = vi.fn(async () => false);
    await expect(
      prepareRuntimeResourceBindings(
        {
          grantStore,
          resolvePanel: async () => ({ source: "about/settings", contextId: "ctx-panel" }),
          confirmPrivilegedPanel,
        },
        { bindings: [binding], initiatingCaller: caller }
      ).then((prepared) => prepared.bind(record))
    ).rejects.toThrow(/denied/u);
    expect(confirmPrivilegedPanel).toHaveBeenCalledOnce();
    expect(grantStore.listActiveAuthorityGrants()).toEqual([]);
  });

  it("fails closed for unowned channels and unauthenticated launches", async () => {
    const deps = {
      grantStore,
      resolvePanel: async () => ({ source: "panels/dashboard", contextId: "ctx-panel" }),
      confirmPrivilegedPanel: async () => true,
    };
    await expect(
      prepareRuntimeResourceBindings(deps, {
        bindings: [{ ...binding, scope: { kind: "agent-channel", channelId: "channel-other" } }],
        initiatingCaller: caller,
      }).then((prepared) => prepared.bind(record))
    ).rejects.toThrow(/own agent channel/u);
    await expect(
      prepareRuntimeResourceBindings(deps, {
        bindings: [binding],
        initiatingCaller: createVerifiedCaller("server", "server"),
      })
    ).rejects.toThrow(/authenticated user gesture/u);
  });

  it("uses an inert entity binding to select context without granting authority", async () => {
    const confirmPrivilegedPanel = vi.fn(async () => true);
    const prepared = await prepareRuntimeResourceBindings(
      {
        grantStore,
        resolvePanel: async () => ({ source: "about/settings", contextId: "ctx-panel" }),
        confirmPrivilegedPanel,
      },
      {
        bindings: [
          {
            resource: { kind: "panel-slot", id: "slot-a" },
            capabilities: [],
            scope: { kind: "entity" },
          },
        ],
        initiatingCaller: caller,
      }
    );

    expect(prepared.contextId).toBe("ctx-panel");
    expect(await prepared.bind({ ...record, agentBinding: undefined })).toEqual([]);
    expect(confirmPrivilegedPanel).not.toHaveBeenCalled();
    expect(grantStore.listActiveAuthorityGrants()).toEqual([]);
  });
});

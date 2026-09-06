import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createVerifiedCaller, type ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import { claudeLaunchProfile } from "@vibestudio/shared/claudeLaunchProfile";
import {
  assertLinkedClaudeBinding,
  createLinkedClaudeService,
  type LinkedClaudeExecution,
  type LinkedClaudeServiceDeps,
} from "./linkedClaudeService.js";

const services: ReturnType<typeof createLinkedClaudeService>[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stop()));
});
const reference = { entityId: "session-one", generationId: "generation-one" };
const input = {
  profile: claudeLaunchProfile({
    launchId: reference.generationId,
    environment: {
      VIBESTUDIO_AGENT_TOKEN: "agent:test:secret",
      VIBESTUDIO_ENTITY_ID: reference.entityId,
      VIBESTUDIO_CONTEXT_ID: "context",
      VIBESTUDIO_CHANNEL_ID: "channel",
      VIBESTUDIO_VESSEL_REF: "vessel",
    },
  }),
  prompt: "test task",
};
function caller(connection = new AbortController()): {
  ctx: ServiceContext;
  connection: AbortController;
} {
  return {
    connection,
    ctx: {
      caller: createVerifiedCaller("extension-one", "extension", null, null, {
        userId: "user",
        handle: "user",
      }),
      connectionId: "connection",
      connectionSignal: connection.signal,
    },
  };
}
async function execution() {
  const child = spawn(
    process.execPath,
    ["-e", 'process.stdout.write("ready\\n");setInterval(()=>{},1000)'],
    { stdio: ["ignore", "pipe", "pipe"] }
  );
  await once(child, "spawn");
  const cleanup = vi.fn(async () => {
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });
  return { child, cleanup };
}
function fixture(launch: NonNullable<LinkedClaudeServiceDeps["launch"]>) {
  const service = createLinkedClaudeService({
    appRoot: "/installed",
    profilesRoot: "/profiles",
    authorize: async () => ({
      contextDirectory: "/context",
      route: {
        url: "http://localhost:1",
        serverId: "server",
        workspaceId: "workspace",
        workspaceName: "workspace",
        transport: "local",
      },
    }),
    launch,
  });
  services.push(service);
  return service;
}
describe("trusted linked Claude generation lifetime", () => {
  it("binds inspection and stop to the actual live connection, not a copied runtime identity", async () => {
    const owned = await execution();
    const service = fixture(async () => owned);
    const first = caller();
    await service.handler(first.ctx, "start", [input]);
    const reconnect = caller();
    await expect(service.handler(reconnect.ctx, "inspect", [reference])).rejects.toThrow(
      "does not belong"
    );
    await expect(service.handler(reconnect.ctx, "stop", [reference])).rejects.toThrow(
      "does not belong"
    );
    await service.handler(first.ctx, "stop", [reference]);
    expect(owned.cleanup).toHaveBeenCalledOnce();
    expect(await service.handler(first.ctx, "stop", [reference])).toEqual({ stopped: false });
  });
  it.each(["disconnect", "shutdown"])(
    "waits for pending launch before %s retirement",
    async (mode) => {
      let complete!: (execution: LinkedClaudeExecution) => void;
      const launch = vi.fn(
        () =>
          new Promise<LinkedClaudeExecution>((resolve) => {
            complete = resolve;
          })
      );
      const service = fixture(launch);
      const owner = caller();
      const starting = service.handler(owner.ctx, "start", [input]);
      const failed = expect(starting).rejects.toThrow(/disconnected/);
      await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce());
      let stopping: Promise<void> | undefined;
      if (mode === "disconnect") owner.connection.abort();
      else stopping = service.stop();
      const owned = await execution();
      complete(owned);
      await failed;
      await stopping;
      expect(owned.cleanup).toHaveBeenCalledOnce();
      expect(owned.child.exitCode !== null || owned.child.signalCode !== null).toBe(true);
    }
  );
  it("retains materialized resources when deferred preparation and its first cleanup fail", async () => {
    let failPreparation!: (error: Error) => void;
    const cleanup = vi.fn(async () => {});
    cleanup.mockRejectedValueOnce(new Error("cleanup denied"));
    const launch = vi.fn<NonNullable<LinkedClaudeServiceDeps["launch"]>>(
      async (_input, _paths, retain) => {
        retain({ cleanup });
        await new Promise<void>((_resolve, reject) => {
          failPreparation = reject;
        });
        throw new Error("unreachable child creation");
      }
    );
    const service = fixture(launch);
    const owner = caller();
    const starting = service.handler(owner.ctx, "start", [input]);
    const rejected = expect(starting).rejects.toThrow("ownership retained");
    await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce());
    expect(cleanup).not.toHaveBeenCalled();
    failPreparation(new Error("MXC preparation failed"));
    await rejected;
    expect(cleanup).toHaveBeenCalledOnce();
    expect(await service.handler(owner.ctx, "inspect", [reference])).toMatchObject({
      state: "exited",
      pid: null,
      exit: { signal: "startup-error" },
    });
    await service.handler(owner.ctx, "stop", [reference]);
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(await service.handler(owner.ctx, "stop", [reference])).toEqual({ stopped: false });
  });

  it("retains reachable ownership when cleanup fails, then retries explicit stop", async () => {
    const owned = await execution();
    owned.cleanup.mockRejectedValueOnce(new Error("cleanup denied"));
    const service = fixture(async () => owned);
    const owner = caller();
    await service.handler(owner.ctx, "start", [input]);
    // Natural exit attempts cleanup. Its failure must not lose the generation.
    owned.child.kill();
    await once(owned.child, "exit");
    await vi.waitFor(() => expect(owned.cleanup).toHaveBeenCalledOnce());
    expect(await service.handler(owner.ctx, "inspect", [reference])).toMatchObject({
      state: "exited",
    });
    await service.handler(owner.ctx, "stop", [reference]);
    expect(owned.cleanup).toHaveBeenCalledTimes(2);
  });
});

describe("linked Claude authoritative identity binding", () => {
  const session = {
    id: "session-one",
    kind: "session",
    status: "active",
    parentId: "owner",
    contextId: "context",
    agentBinding: { entityId: "session-one", contextId: "context", channelId: "channel" },
  };
  const vessel = {
    id: "vessel",
    kind: "do",
    status: "active",
    parentId: "owner",
    contextId: "context",
    agentBinding: session.agentBinding,
    stateArgs: { linkedEntityId: session.id },
  };
  const check = (
    change: {
      auth?: unknown;
      entity?: unknown;
      vessel?: unknown;
      input?: unknown;
      caller?: string;
    } = {}
  ) =>
    assertLinkedClaudeBinding(
      change.caller ?? "owner",
      (change.input ?? input) as never,
      ("auth" in change ? change.auth : { entityId: session.id }) as never,
      "agent",
      (change.entity ?? session) as never,
      (change.vessel ?? vessel) as never
    );
  it("accepts only the current graph-owned identity", () =>
    expect(check()).toMatchObject({ entityId: session.id }));
  it.each([
    { auth: null },
    { auth: { entityId: "other" } },
    { caller: "other" },
    { entity: { ...session, status: "retired" } },
    { entity: { ...session, agentBinding: { ...session.agentBinding, channelId: "other" } } },
    { vessel: { ...vessel, parentId: "other" } },
    { vessel: { ...vessel, contextId: "other" } },
    { vessel: { ...vessel, stateArgs: { linkedEntityId: "other" } } },
    {
      vessel: {
        ...vessel,
        stateArgs: {
          linkedEntityId: session.id,
          subagent: { runId: "undeclared", parentChannelId: "other" },
        },
      },
    },
  ])("rejects mismatched authority coordinates", (change) =>
    expect(() => check(change)).toThrow("exact owned live")
  );
});

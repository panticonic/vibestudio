import { describe, expect, it, vi } from "vitest";
import { createVerifiedCaller, type ServiceContext } from "@vibestudio/shared/serviceDispatcher";
import type { HostDescriptor } from "@vibestudio/workspace-contracts/clients";
import { createClientLaunchService } from "./clientLaunchService.js";
import type { ClientHost } from "./clientRegistry.js";

const HOST: HostDescriptor = {
  host: "terminal",
  hostVersion: "1.0.0",
  runtimes: { terminal: "terminal-host-1" },
  capabilities: ["device-session"],
};

function fixture(opts: { host?: Partial<Record<keyof ClientHost, unknown>> } = {}) {
  const clientHost = {
    launch: vi.fn(async () => ({ state: "unavailable", reason: "nope" })),
    listClients: vi.fn(async () => []),
    integrationSnapshot: vi.fn(async () => ({
      clients: [
        {
          source: "clients/chat-terminal",
          activeBuildKey: "build-1",
          id: "chat",
          title: "Chat",
          intents: [
            {
              name: "open-conversation",
              kind: "foreground",
              params: { conversation: "string" },
              dynamic: "vibestudio.chat.v1#recentConversations",
            },
          ],
        },
        {
          source: "clients/notes",
          activeBuildKey: null,
          id: "notes",
          title: "Notes",
          intents: [{ name: "recent", kind: "foreground", dynamic: "notes.v1#recent" }],
        },
      ],
    })),
    resolveBackgroundIntent: vi.fn(() => ({
      source: "clients/chat-terminal",
      intent: {
        name: "ask",
        kind: "background",
        handler: "vibestudio.chat.v1#ask",
        params: { prompt: "text" },
      },
    })),
    ...opts.host,
  } as unknown as ClientHost;
  const callClientHandler = vi.fn(
    async ({ handler }: { handler: string }): Promise<unknown> =>
      handler === "vibestudio.chat.v1#recentConversations"
        ? [{ title: "Trip plans", params: { conversation: "c-1" } }]
        : "hello"
  );
  const service = createClientLaunchService({
    getClientHost: () => clientHost,
    callClientHandler,
  });
  const ctx = (caller = createVerifiedCaller("shell:device-1", "shell")) =>
    ({ caller }) as ServiceContext;
  return { service, clientHost, callClientHandler, ctx };
}

describe("clients service", () => {
  it("declares host-only methods under the clients families", () => {
    const { service } = fixture();
    expect(Object.keys(service.methods ?? {}).sort()).toEqual([
      "integrationSnapshot",
      "invokeIntent",
      "launch",
      "list",
    ]);
    const families = Object.fromEntries(
      Object.entries(service.methods ?? {}).map(([name, method]) => [name, method.tier?.family])
    );
    expect(families).toEqual({
      launch: "clients.launch",
      invokeIntent: "clients.launch",
      list: "clients.read",
      integrationSnapshot: "clients.read",
    });
  });

  it("is reachable only by the device host that owns the connection", async () => {
    const { service, clientHost, ctx } = fixture();
    for (const caller of [
      createVerifiedCaller("panel:one", "panel"),
      createVerifiedCaller("client:browser:web:device-1", "client"),
      createVerifiedCaller("server", "server"),
      createVerifiedCaller("headless-host", "shell"),
    ]) {
      await expect(service.handler(ctx(caller), "list", [HOST])).rejects.toMatchObject({
        code: "EACCES",
      });
    }
    expect(clientHost!.listClients).not.toHaveBeenCalled();
    await expect(service.handler(ctx(), "list", [HOST])).resolves.toEqual([]);
    await expect(
      service.handler(ctx(createVerifiedCaller("electron-main", "shell")), "list", [HOST])
    ).resolves.toEqual([]);
  });

  it("delegates launch to the registry, including a rollback request", async () => {
    const { service, clientHost, ctx } = fixture();
    await expect(
      service.handler(ctx(), "launch", [
        { host: HOST, select: { id: "chat" }, rollbackTo: "build-1" },
      ])
    ).resolves.toEqual({ state: "unavailable", reason: "nope" });
    expect(clientHost!.launch).toHaveBeenCalledWith({
      host: HOST,
      select: { id: "chat" },
      rollbackTo: "build-1",
    });
  });

  it("projects dynamic entries of running clients into the integration snapshot", async () => {
    const { service, callClientHandler, ctx } = fixture();
    const snapshot = (await service.handler(ctx(), "integrationSnapshot", [HOST])) as {
      clients: Array<{ id: string; entries: unknown }>;
    };
    expect(snapshot.clients.map(({ id, entries }) => ({ id, entries }))).toEqual([
      {
        id: "chat",
        entries: {
          "open-conversation": [{ title: "Trip plans", params: { conversation: "c-1" } }],
        },
      },
      { id: "notes", entries: {} },
    ]);
    expect(callClientHandler).toHaveBeenCalledTimes(1);
    expect(callClientHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "clients/chat-terminal",
        handler: "vibestudio.chat.v1#recentConversations",
        params: {},
      })
    );
  });

  it("reports a client whose dynamic entries are invalid in its own entry, not as a snapshot failure", async () => {
    const { service, callClientHandler, ctx } = fixture();
    callClientHandler.mockResolvedValueOnce([{ title: "Bad", params: { other: "x" } }]);
    const snapshot = (await service.handler(ctx(), "integrationSnapshot", [HOST])) as {
      clients: Array<{ id: string; entries: unknown; error?: string }>;
    };
    expect(snapshot.clients.map(({ id, entries, error }) => ({ id, entries, error }))).toEqual([
      { id: "chat", entries: {}, error: expect.stringMatching(/does not declare/) },
      { id: "notes", entries: {}, error: undefined },
    ]);
  });

  it("keeps projecting the other clients when one client's handler throws", async () => {
    const { service, callClientHandler, ctx, clientHost } = fixture();
    (clientHost!.integrationSnapshot as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      clients: [
        {
          source: "clients/broken",
          activeBuildKey: "b",
          id: "broken",
          title: "Broken",
          intents: [{ name: "x", kind: "foreground", dynamic: "broken.v1#x" }],
        },
        {
          source: "clients/chat-terminal",
          activeBuildKey: "build-1",
          id: "chat",
          title: "Chat",
          intents: [
            {
              name: "open-conversation",
              kind: "foreground",
              params: { conversation: "string" },
              dynamic: "vibestudio.chat.v1#recentConversations",
            },
          ],
        },
      ],
    });
    callClientHandler.mockImplementation(async ({ handler }: { handler: string }) => {
      if (handler === "broken.v1#x") throw new Error("handler exploded");
      return [{ title: "Trip plans", params: { conversation: "c-1" } }];
    });
    const snapshot = (await service.handler(ctx(), "integrationSnapshot", [HOST])) as {
      clients: Array<{ id: string; entries: Record<string, unknown>; error?: string }>;
    };
    expect(snapshot.clients[0]).toMatchObject({ id: "broken", error: "handler exploded" });
    expect(snapshot.clients[1]).toMatchObject({ id: "chat" });
    expect(snapshot.clients[1]!.entries["open-conversation"]).toHaveLength(1);
  });

  it("requires a background intent handler to return text", async () => {
    const { service, callClientHandler, ctx } = fixture();
    callClientHandler.mockResolvedValueOnce({ channelId: "ch-1" });
    await expect(
      service.handler(ctx(), "invokeIntent", [HOST, { id: "chat", intent: "ask" }])
    ).rejects.toThrow("must return text");
  });

  it("runs a background intent through its handler with the declared parameters only", async () => {
    const { service, callClientHandler, ctx } = fixture();
    await expect(
      service.handler(ctx(), "invokeIntent", [
        HOST,
        { id: "chat", intent: "ask", params: { prompt: "hi" } },
      ])
    ).resolves.toEqual({ text: "hello" });
    expect(callClientHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "clients/chat-terminal",
        handler: "vibestudio.chat.v1#ask",
        params: { prompt: "hi" },
      })
    );
    await expect(
      service.handler(ctx(), "invokeIntent", [
        HOST,
        { id: "chat", intent: "ask", params: { nope: "x" } },
      ])
    ).rejects.toMatchObject({ code: "EINVAL" });
    expect(callClientHandler).toHaveBeenCalledTimes(1);
  });
});

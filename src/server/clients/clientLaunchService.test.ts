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

function fixture(opts: { host?: Partial<Record<keyof ClientHost, unknown>> | null } = {}) {
  const clientHost =
    opts.host === null
      ? null
      : ({
          launch: vi.fn(async () => ({ state: "unavailable", reason: "nope" })),
          listClients: vi.fn(async () => []),
          integrationSnapshot: vi.fn(async () => ({
            clients: [{ id: "chat", title: "Chat", intents: [] }],
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
        } as unknown as ClientHost);
  const invokeIntentHandler = vi.fn(async () => ({ text: "hello" }));
  const service = createClientLaunchService({
    getClientHost: () => clientHost,
    invokeIntentHandler,
  });
  const ctx = (caller = createVerifiedCaller("shell:device-1", "shell")) =>
    ({ caller }) as ServiceContext;
  return { service, clientHost, invokeIntentHandler, ctx };
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

  it("reports that clients run only from System when there is no ClientHost", async () => {
    const { service, ctx } = fixture({ host: null });
    await expect(
      service.handler(ctx(), "launch", [{ host: HOST, select: { default: true } }])
    ).rejects.toMatchObject({
      code: "CLIENTS_UNAVAILABLE",
      message: expect.stringContaining("only from the System workspace"),
    });
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

  it("projects the integration snapshot with an entries slot per client", async () => {
    const { service, ctx } = fixture();
    await expect(service.handler(ctx(), "integrationSnapshot", [HOST])).resolves.toEqual({
      clients: [{ id: "chat", title: "Chat", intents: [], entries: {} }],
    });
  });

  it("runs a background intent through its handler with the declared parameters only", async () => {
    const { service, invokeIntentHandler, ctx } = fixture();
    await expect(
      service.handler(ctx(), "invokeIntent", [
        HOST,
        { id: "chat", intent: "ask", params: { prompt: "hi" } },
      ])
    ).resolves.toEqual({ text: "hello" });
    expect(invokeIntentHandler).toHaveBeenCalledWith(
      expect.objectContaining({ source: "clients/chat-terminal", params: { prompt: "hi" } })
    );
    await expect(
      service.handler(ctx(), "invokeIntent", [
        HOST,
        { id: "chat", intent: "ask", params: { nope: "x" } },
      ])
    ).rejects.toMatchObject({ code: "EINVAL" });
    expect(invokeIntentHandler).toHaveBeenCalledTimes(1);
  });
});

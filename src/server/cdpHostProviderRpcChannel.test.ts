import { describe, expect, it } from "vitest";
import { CdpBridge } from "./cdpBridge.js";
import { CdpHostProviderRpcChannel } from "./cdpHostProviderRpcChannel.js";

function createFrameReader(response: Response): () => Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("response body missing");
  const decoder = new TextDecoder();
  let buffered = "";

  return async () => {
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        const payload = JSON.parse(line) as string;
        return JSON.parse(payload) as Record<string, unknown>;
      }
      const { done, value } = await reader.read();
      if (done) throw new Error("stream ended before a frame was available");
      buffered += decoder.decode(value, { stream: true });
    }
  };
}

async function waitForTargetRegistered(bridge: CdpBridge, targetId: string): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (bridge.isTargetRegistered(targetId)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for target registration: ${targetId}`);
}

describe("CdpHostProviderRpcChannel", () => {
  it("adapts a remote provider stream into the CdpBridge provider contract", async () => {
    const bridge = new CdpBridge({
      adminToken: "admin-token",
      externalHost: "127.0.0.1",
      port: 0,
    });
    const channel = new CdpHostProviderRpcChannel(bridge);
    const response = channel.open("provider-session", "desktop-host", {
      id: "shell:desktop",
      kind: "shell",
    });
    const readFrame = createFrameReader(response);

    await expect(readFrame()).resolves.toMatchObject({ type: "vibestudio:cdp-auth-ok" });

    channel.send(
      "provider-session",
      JSON.stringify({ type: "cdp:register", targetId: "panel:tree/panel-1", tabId: 7 }),
      { id: "shell:desktop", kind: "shell" }
    );
    await waitForTargetRegistered(bridge, "panel:tree/panel-1");

    const commandPromise = bridge.sendHostCommand("panel:tree/panel-1", "openDevTools", ["right"]);
    const command = await readFrame();
    expect(command).toMatchObject({
      type: "host:command",
      targetId: "panel:tree/panel-1",
      action: "openDevTools",
      args: ["right"],
      requestId: expect.any(String),
    });

    channel.send(
      "provider-session",
      JSON.stringify({
        type: "host:result",
        targetId: "panel:tree/panel-1",
        requestId: command["requestId"],
        result: null,
      }),
      { id: "shell:desktop", kind: "shell" }
    );

    await expect(commandPromise).resolves.toBeNull();
    channel.close("provider-session", { id: "shell:desktop", kind: "shell" });
    await bridge.stop();
  });

  it("binds remote provider sessions to the owning shell caller", async () => {
    const bridge = new CdpBridge({
      adminToken: "admin-token",
      externalHost: "127.0.0.1",
      port: 0,
      canRegisterHostProvider: (hostConnectionId, ownerCallerId) =>
        hostConnectionId === "desktop-host" && ownerCallerId === "shell:desktop",
    });
    const channel = new CdpHostProviderRpcChannel(bridge);

    expect(() =>
      channel.open("provider-session-other", "desktop-host", {
        id: "shell:other",
        kind: "shell",
      })
    ).toThrow(/not authorized/);

    const response = channel.open("provider-session", "desktop-host", {
      id: "shell:desktop",
      kind: "shell",
    });
    const readFrame = createFrameReader(response);
    await expect(readFrame()).resolves.toMatchObject({ type: "vibestudio:cdp-auth-ok" });

    expect(() =>
      channel.send("provider-session", "{}", { id: "shell:other", kind: "shell" })
    ).toThrow(/not authorized/);
    expect(() => channel.close("provider-session", { id: "shell:other", kind: "shell" })).toThrow(
      /not authorized/
    );

    channel.close("provider-session", { id: "shell:desktop", kind: "shell" });
    await bridge.stop();
  });
});

import { describe, expect, it } from "vitest";
import { createRnClientApi } from "./api";
import { createMemoryBroker } from "./testing";
import { METHOD_CAPABILITY, type ClientDescription } from "./protocol";
import { INTEGRATION_METHOD_CAPABILITY, type InstalledLauncher } from "./integrationProtocol";

const description: ClientDescription = {
  principalId: "client:chat:react-native:dev",
  clientId: "chat",
  source: "clients/chat-mobile",
  title: "Chat",
  buildKey: "bk",
  effectiveVersion: "1.0.0",
  deviceId: "dev",
  platform: "android",
  grantedCapabilities: ["integration.install"],
  developmentMode: false,
  intent: null,
};

const launcher: InstalledLauncher = {
  launcherId: "vibestudio://c/chat/open",
  clientId: "chat",
  label: "Chat",
  link: "vibestudio://c/chat/open",
};

async function setup() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const { channel, host } = createMemoryBroker((method, args) => {
    calls.push({ method, args });
    switch (method) {
      case "client.describe":
        return description;
      case "updates.pending":
        return null;
      case "integration.install":
        return { outcome: "requested" };
      case "integration.list":
        return [launcher];
      case "integration.remove":
        return undefined;
      default:
        throw new Error(`unexpected ${method}`);
    }
  });
  return { api: await createRnClientApi(channel), host, calls };
}

describe("integration.install", () => {
  it("asks the host to install, list and remove a client's launcher by client id", async () => {
    const { api, calls } = await setup();
    await expect(api.integration.install("chat")).resolves.toEqual({ outcome: "requested" });
    await expect(api.integration.list()).resolves.toEqual([launcher]);
    await api.integration.remove("chat");
    expect(calls.filter((call) => call.method.startsWith("integration."))).toEqual([
      { method: "integration.install", args: [{ id: "chat" }] },
      { method: "integration.list", args: [] },
      { method: "integration.remove", args: [{ id: "chat" }] },
    ]);
  });

  it("tells a client when the set of confirmed launchers changes, until it unsubscribes", async () => {
    const { api, host } = await setup();
    const seen: Array<readonly InstalledLauncher[]> = [];
    const stop = api.integration.onChange((launchers) => seen.push(launchers));
    host.emit({ type: "integration-launchers", launchers: [launcher] });
    stop();
    host.emit({ type: "integration-launchers", launchers: [] });
    expect(seen).toEqual([[launcher]]);
  });

  it("gates every method on the integration.install capability", () => {
    for (const method of Object.keys(INTEGRATION_METHOD_CAPABILITY)) {
      expect(METHOD_CAPABILITY[method as keyof typeof METHOD_CAPABILITY]).toBe("integration.install");
    }
  });
});

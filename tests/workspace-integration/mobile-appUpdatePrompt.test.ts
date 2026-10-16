import { describe, expect, it, vi } from "vitest";
import { decodeRpcJson, encodeRpcJson } from "@vibestudio/rpc";
import { createRnClientApi } from "@vibestudio/rn-client-api";
import { createMemoryBroker } from "@vibestudio/rn-client-api/testing";
import type { ClientHostMethod } from "@vibestudio/rn-client-api/protocol";
import type { SupervisionChange } from "@vibestudio/shared/events";
import { ClientInstance } from "../../hosts/react-native/src/host/clientInstance";
import { HostState } from "../../hosts/react-native/src/host/hostState";
import {
  createHostUpdateModel,
  observeHostUpdates,
} from "@exact-userland/packages/client-kit-native/src/update/hostUpdates";
import { presentClientUpdates } from "@exact-userland/packages/client-kit-native/src/update/clientUpdatePrompt";

/**
 * The mobile update contract end to end: the server announces a ready build,
 * the host runtime offers it to the client's instance, the client's kit
 * prompts, and the person's answer is a request to the host that reloads only
 * that client (docs/client-hosts-and-clients-plan.md section 4.6). Both halves
 * are the real modules; only the native broker and the server are fakes.
 */

function mobileChange(over: Partial<SupervisionChange> = {}): SupervisionChange {
  return {
    identity: { kind: "client", entityId: "browser" },
    source: "clients/mobile-browser",
    status: "running",
    lastError: null,
    artifact: { effectiveVersion: "2.0.0", buildKey: "rn-2", executionDigest: null },
    canRollback: false,
    change: "adopted",
    previousBuildKey: "rn-1",
    previousEffectiveVersion: "1.0.0",
    client: { id: "browser", runtime: "react-native", grantedCapabilities: [] },
    ...over,
  } as SupervisionChange;
}

async function setup() {
  const hooks = {
    restart: vi.fn(async () => undefined),
    rollback: vi.fn(async () => undefined),
    trustRevoked: vi.fn(),
    resetDevice: vi.fn(async () => undefined),
  };
  let emit: (event: never) => void = () => undefined;
  const instance = new ClientInstance({
    launched: {
      client: {
        source: "clients/mobile-browser",
        id: "browser",
        runtime: "react-native",
        title: "Vibestudio",
        buildKey: "rn-1",
        executionDigest: "a".repeat(64),
        effectiveVersion: "1.0.0",
        hostAbi: "rn-host-6",
        artifacts: [],
        grantedCapabilities: [],
        deniedOptional: [],
      },
      artifacts: [],
      grant: {
        connectionGrant: "g",
        expiresAt: 1,
        principalId: "client:browser:react-native:dev1",
        deviceId: "dev1",
        serverId: "srv",
        serverBootId: "boot",
        workspaceId: "ws",
      },
    },
    platform: "android",
    openers: {} as never,
    grants: { acquire: vi.fn() },
    state: new HostState({
      get: async () => null,
      set: async () => undefined,
      remove: async () => undefined,
      keys: async () => [],
    }),
    device: {} as never,
    hooks,
    notifications: {} as never,
    intent: null,
    deliver: (event) => emit(event as never),
  });
  const { channel, host } = createMemoryBroker(async (method: ClientHostMethod, args) => {
    const outcome = await instance.broker.handle(method, encodeRpcJson(args));
    if (!outcome.ok) throw Object.assign(new Error(outcome.message), { code: outcome.code });
    return decodeRpcJson(outcome.resultJson);
  });
  emit = host.emit as never;
  const api = await createRnClientApi(channel);
  const model = createHostUpdateModel(api);
  observeHostUpdates(api, model);
  const alert = vi.fn();
  const notify = vi.fn();
  presentClientUpdates(model, { alert: alert as never, notify });
  const offer = (change: SupervisionChange) =>
    instance.offerUpdate({
      buildKey: change.artifact.buildKey!,
      effectiveVersion: change.artifact.effectiveVersion,
      previousBuildKey: change.previousBuildKey,
      change,
    });
  return { hooks, alert, notify, offer };
}

const pressed = (alert: ReturnType<typeof vi.fn>, text: string) => {
  const buttons = alert.mock.calls[0]?.[2] as Array<{ text: string; onPress?: () => void }>;
  buttons.find((button) => button.text === text)?.onPress?.();
  return buttons.map((button) => button.text);
};

describe("mobile client update prompt", () => {
  it("prompts once for the announced build and reloads this client when asked to install", async () => {
    const t = await setup();

    t.offer(mobileChange());
    expect(pressed(t.alert, "Install")).toEqual(["Later", "Install"]);
    await vi.waitFor(() => expect(t.hooks.restart).toHaveBeenCalledTimes(1));

    // The same build is not offered twice.
    t.offer(mobileChange());
    expect(t.alert).toHaveBeenCalledTimes(1);
  });

  it("returns to the previous trusted build, through the host, when asked to roll back", async () => {
    const t = await setup();

    t.offer(mobileChange({ canRollback: true }));
    expect(pressed(t.alert, "Roll back")).toEqual(["Later", "Roll back", "Install"]);

    await vi.waitFor(() => expect(t.hooks.rollback).toHaveBeenCalledTimes(1));
    expect(t.hooks.restart).not.toHaveBeenCalled();
  });

  it("says plainly when the host could not take the build, and keeps the failure", async () => {
    const t = await setup();
    t.hooks.restart.mockRejectedValueOnce(new Error("bundle failed"));

    t.offer(mobileChange());
    pressed(t.alert, "Install");

    await vi.waitFor(() =>
      expect(t.notify).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Update failed", message: "bundle failed", tone: "danger" })
      )
    );
  });

  it("ignores announcements about other runtimes", async () => {
    const t = await setup();

    t.offer(
      mobileChange({
        client: { id: "browser", runtime: "web", grantedCapabilities: [] },
      } as never)
    );

    expect(t.alert).not.toHaveBeenCalled();
    expect(t.notify).not.toHaveBeenCalled();
  });
});

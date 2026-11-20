import { runInNewContext } from "node:vm";
import { afterEach, expect, it, vi } from "vitest";
import type { RpcEnvelope } from "@vibestudio/rpc";
import {
  SHELL_BINDING,
  shellBridgeScript,
} from "../../packages/headless-renderer/src/panelShellBridge.js";
import type { ShellEnvelopeBridge } from "./browserShellBridge.js";

const createWsTransport = vi.hoisted(() => vi.fn());
vi.mock("../../hosts/desktop/preload/wsTransport.js", () => ({ createWsTransport }));

const entityId = "panel:nav-a";
const slotId = "panel:tree/a";
const server = { callerId: "main", callerKind: "server" } as const;

function envelope(message: RpcEnvelope["message"]): RpcEnvelope {
  return {
    from: "main",
    target: entityId,
    delivery: { caller: server },
    provenance: [server],
    message,
  };
}

function panelDetail(runtimeId: string, ownerStage: string) {
  return {
    revision: 1,
    slot: {
      slot_id: slotId,
      parent_slot_id: null,
      current_entity_id: runtimeId,
      current_entry_key: "entry-a",
      sort_key: 0,
      created_at: 0,
      closed_at: null,
    },
    currentHistory: {
      slot_id: slotId,
      cursor: 0,
      entry_key: "entry-a",
      entity_id: runtimeId,
      source: "panels/rehearsal",
      context_id: "context-a",
      state_args: JSON.stringify({ ownerStage }),
      recorded_at: 0,
    },
    entity: {
      id: runtimeId,
      authoritySessionId: "lifetime:a",
      kind: "panel",
      source: { repoPath: "panels/rehearsal", effectiveVersion: "build-a" },
      contextId: "context-a",
      key: "a",
      createdAt: 0,
      status: "active",
      cleanupComplete: false,
    },
  };
}

async function setup(transport: "fallback WebSocket" | "injected Iroh") {
  const page = {
    __vibestudioStateArgs: { ownerStage: "initial" },
    dispatchEvent: vi.fn(),
  };
  let receiveRequest!: (value: RpcEnvelope) => void;
  const request = new Promise<RpcEnvelope>((resolve) => {
    receiveRequest = resolve;
  });
  const init = {
    workspaceId: "workspace:test",
    entityId,
    slotId,
    gatewayConfig: { serverUrl: "http://localhost:4567", token: "owned-test-grant" },
    connectionId: "runtime-a",
  };
  vi.stubGlobal("window", page);
  vi.stubGlobal("__vibestudioPanelInit", init);
  vi.stubGlobal("__vibestudioEntityId", entityId);
  vi.stubGlobal("__vibestudioSlotId", slotId);
  vi.stubGlobal("__vibestudioWorkspaceId", init.workspaceId);
  vi.stubGlobal("__vibestudioPreparePanelStateArgs", undefined);
  vi.stubGlobal("__vibestudioShell", undefined);

  const release = vi.fn();
  let receive: (value: RpcEnvelope) => void;
  if (transport === "fallback WebSocket") {
    const handlers = new Set<(value: RpcEnvelope) => void>();
    createWsTransport.mockReturnValue({
      ready: async () => undefined,
      send: (value: RpcEnvelope) => receiveRequest(value),
      onMessage(handler: (value: RpcEnvelope) => void) {
        handlers.add(handler);
        return () => {
          handlers.delete(handler);
          release();
        };
      },
    });
    receive = (value) => {
      for (const handler of handlers) handler(value);
    };
  } else {
    const realm = {
      [SHELL_BINDING](raw: string) {
        const message = JSON.parse(raw);
        if (message.t === "envelope") receiveRequest(message.envelope);
      },
    } as unknown as {
      __vibestudioShell: ShellEnvelopeBridge;
      __vibestudioShellDeliver: (raw: string) => void;
    };
    runInNewContext(shellBridgeScript(), realm);
    realm.__vibestudioShellDeliver(JSON.stringify({ t: "ready" }));
    const onEnvelope = realm.__vibestudioShell.onEnvelope!;
    realm.__vibestudioShell.onEnvelope = (handler) => {
      const unsubscribe = onEnvelope(handler);
      return () => {
        unsubscribe();
        release();
      };
    };
    vi.stubGlobal("__vibestudioShell", realm.__vibestudioShell);
    receive = (value) =>
      realm.__vibestudioShellDeliver(JSON.stringify({ t: "envelope", envelope: value }));
  }

  vi.resetModules();
  await import("./browserTransportEntry.js");
  const globals = globalThis as typeof globalThis & {
    __vibestudioPreparePanelStateArgs: () => Promise<void>;
  };
  return {
    page,
    receive,
    request,
    prepare: globals.__vibestudioPreparePanelStateArgs,
    release,
    commit(ownerStage: string) {
      receive(
        envelope({
          type: "event",
          fromId: "main",
          event: "runtime:stateArgsChanged",
          payload: { ownerStage },
        })
      );
    },
    async reply(runtimeId: string, ownerStage: string) {
      const outbound = await request;
      expect(outbound).toMatchObject({
        from: entityId,
        target: "main",
        message: { type: "request", method: "workspace-state.panelTree.detail", args: [slotId] },
      });
      if (outbound.message.type !== "request") throw new Error("Expected addressed detail request");
      receive(
        envelope({
          type: "response",
          requestId: outbound.message.requestId,
          result: panelDetail(runtimeId, ownerStage),
        })
      );
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

const transports = ["fallback WebSocket", "injected Iroh"] as const;

it.each(transports)("loads a commit missed before subscription via %s", async (transport) => {
  const harness = await setup(transport);
  const prepared = harness.prepare();
  await harness.reply(entityId, "committed-before-subscription");
  await prepared;
  expect(harness.page.__vibestudioStateArgs).toEqual({
    ownerStage: "committed-before-subscription",
  });
  expect(harness.release).toHaveBeenCalledOnce();
  expect(harness.page.dispatchEvent).not.toHaveBeenCalled();
});

it.each(transports)(
  "preserves a commit delivered during the startup read via %s",
  async (transport) => {
    const harness = await setup(transport);
    const prepared = harness.prepare();
    await harness.request;
    harness.commit("committed-during-read");
    await harness.reply(entityId, "older-read");
    await prepared;
    expect(harness.page.__vibestudioStateArgs).toEqual({ ownerStage: "committed-during-read" });
    expect(harness.release).toHaveBeenCalledOnce();

    harness.commit("live-commit-after-startup");
    expect(harness.page.__vibestudioStateArgs).toEqual({ ownerStage: "live-commit-after-startup" });
    expect(harness.page.dispatchEvent).not.toHaveBeenCalled();
  }
);

it.each(transports)(
  "refuses a moved runtime and releases the read listener via %s",
  async (transport) => {
    const harness = await setup(transport);
    const prepared = harness.prepare();
    const rejected = expect(prepared).rejects.toThrow(
      /moved while runtime panel:nav-a was connecting/
    );
    await harness.reply("panel:nav-replacement", "replacement-args");
    await rejected;
    expect(harness.page.__vibestudioStateArgs).toEqual({ ownerStage: "initial" });
    expect(harness.release).toHaveBeenCalledOnce();
  }
);

it("ignores non-server state argument notifications", async () => {
  const harness = await setup("fallback WebSocket");
  harness.receive({
    ...envelope({
      type: "event",
      fromId: "panel:nav-other",
      event: "runtime:stateArgsChanged",
      payload: { ownerStage: "uncommitted" },
    }),
    delivery: { caller: { callerId: "panel:nav-other", callerKind: "panel" } },
  });
  expect(harness.page.__vibestudioStateArgs).toEqual({ ownerStage: "initial" });
});

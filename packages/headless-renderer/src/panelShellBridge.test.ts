import { describe, expect, it, vi } from "vitest";
import type { RpcEnvelope } from "@vibestudio/rpc";
import {
  PanelShellBridge,
  SHELL_BINDING,
  shellBridgeScript,
  type PanelShellSession,
} from "./panelShellBridge.js";

const envelope = (body: Record<string, unknown>): RpcEnvelope =>
  ({ from: "page", delivery: {}, provenance: [], message: body }) as unknown as RpcEnvelope;

function setup() {
  const listeners = new Set<
    (event: { method: string; params: unknown; sessionId?: string }) => void
  >();
  const sent: Array<{ method: string; params?: Record<string, unknown>; sessionId?: string }> = [];
  const cdp = {
    async send(method: string, params?: Record<string, unknown>, sessionId?: string) {
      sent.push({ method, ...(params ? { params } : {}), ...(sessionId ? { sessionId } : {}) });
      return {};
    },
    onEvent(listener: (event: { method: string; params: unknown; sessionId?: string }) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const inbound: Array<(envelope: RpcEnvelope) => void> = [];
  const session = {
    sent: [] as RpcEnvelope[],
    closed: false,
    callerId: () => "panel-entity",
    async send(value: RpcEnvelope) {
      session.sent.push(value);
    },
    onMessage(listener: (value: RpcEnvelope) => void) {
      inbound.push(listener);
      return () => undefined;
    },
    async close() {
      session.closed = true;
    },
  };
  const opened = vi.fn(async () => session as unknown as PanelShellSession);
  const bridge = new PanelShellBridge(cdp, "cdp-1", opened);
  /** What the page does: call the binding. */
  const fromPage = (message: unknown, sessionId = "cdp-1") => {
    for (const listener of listeners)
      listener({
        method: "Runtime.bindingCalled",
        params: { name: SHELL_BINDING, payload: JSON.stringify(message) },
        sessionId,
      });
  };
  const delivered = () =>
    sent
      .filter((entry) => entry.method === "Runtime.evaluate")
      .map((entry) =>
        JSON.parse(
          JSON.parse(
            String(entry.params!["expression"])
              .replace(/^__vibestudioShellDeliver\(/u, "")
              .replace(/\)$/u, "")
          )
        )
      );
  return { bridge, session, opened, fromPage, delivered, sent, inbound };
}

describe("panel shell bridge", () => {
  it("installs the binding on the page's session and a shell the panel's runtime can use", async () => {
    const { bridge, sent } = setup();
    await bridge.install();
    expect(sent).toEqual([
      { method: "Runtime.addBinding", params: { name: SHELL_BINDING }, sessionId: "cdp-1" },
    ]);
    const script = shellBridgeScript();
    for (const member of [
      "postEnvelope",
      "onEnvelope",
      "onRecovery",
      "streamOpen",
      "streamBodyChunk",
      "streamAck",
      "onStreamMessage",
      "getPanelInit",
    ])
      expect(script).toContain(member);
    expect(script).toContain('streamChunkFormat: "base64"');
  });

  it("opens the panel's session when the page says hello, and tells the page it is ready", async () => {
    const { bridge, fromPage, opened, delivered } = setup();
    await bridge.install();
    expect(opened).not.toHaveBeenCalled();
    fromPage({ t: "hello" });
    await vi.waitFor(() => expect(delivered()).toContainEqual({ t: "ready" }));
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it("relays the page's envelopes on the session stamped as the authenticated panel, and the session's to the page", async () => {
    const { bridge, fromPage, session, delivered, inbound } = setup();
    await bridge.install();
    fromPage({ t: "hello" });
    fromPage({
      t: "envelope",
      envelope: envelope({ type: "request", requestId: "r1", method: "x" }),
    });
    await vi.waitFor(() => expect(session.sent).toHaveLength(1));
    expect(session.sent[0]).toMatchObject({
      from: "panel-entity",
      delivery: { caller: { callerId: "panel-entity", callerKind: "panel" } },
    });
    const reply = envelope({ type: "response", requestId: "r1" });
    for (const listener of inbound) listener(reply);
    await vi.waitFor(() => expect(delivered()).toContainEqual({ t: "envelope", envelope: reply }));
  });

  it("ignores bindings of other pages", async () => {
    const { bridge, fromPage, opened } = setup();
    await bridge.install();
    fromPage({ t: "hello" }, "another-session");
    expect(opened).not.toHaveBeenCalled();
  });

  it("tells the page why its session could not open, and retires the session when the panel is unloaded", async () => {
    const failing = setup();
    failing.opened.mockRejectedValueOnce(new Error("lease denied"));
    await failing.bridge.install();
    failing.fromPage({ t: "hello" });
    await vi.waitFor(() =>
      expect(failing.delivered()).toContainEqual({ t: "ready", error: "lease denied" })
    );

    const working = setup();
    await working.bridge.install();
    working.fromPage({ t: "hello" });
    await vi.waitFor(() => expect(working.delivered()).toContainEqual({ t: "ready" }));
    await working.bridge.close();
    expect(working.session.closed).toBe(true);
  });
});

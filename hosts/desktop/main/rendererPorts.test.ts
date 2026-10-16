import { beforeEach, describe, expect, it, vi } from "vitest";

const listeners = new Map<string, (...args: never[]) => void>();
vi.mock("electron", () => ({
  ipcMain: {
    on: (channel: string, listener: (...args: never[]) => void) => listeners.set(channel, listener),
    off: (channel: string) => listeners.delete(channel),
  },
  MessageChannelMain: class {},
}));

import { RendererPortBroker } from "./rendererPorts.js";
import {
  RPC_PORT_GRANT_CHANNEL,
  RPC_PORT_LOST_CHANNEL,
  RPC_PORT_REQUEST_CHANNEL,
} from "../connection/rendererPortProtocol.js";

const binding = {
  caller: { callerId: "window:a", callerKind: "client" as const },
  state: { hostsPanels: false },
};

function document() {
  const frame = { postMessage: vi.fn(), isDestroyed: () => false };
  const contents = {
    id: 7,
    mainFrame: frame,
    isDestroyed: () => false,
    send: vi.fn(),
    once: vi.fn(),
  };
  return { frame, contents, event: { sender: contents, senderFrame: frame } };
}

function broker(
  bindPort = vi.fn(async () => undefined),
  resolved: typeof binding | null = binding
) {
  const port1 = {};
  const port2 = { close: vi.fn() };
  const instance = new RendererPortBroker({
    link: () => ({ bindPort }) as never,
    resolveBinding: () => resolved,
    createChannel: () => ({ port1: port1 as never, port2: port2 as never }),
  });
  instance.install();
  return { instance, bindPort, port1, port2 };
}
const request = (event: unknown) =>
  (listeners.get(RPC_PORT_REQUEST_CHANNEL) as (e: unknown) => void)(event);

describe("renderer port broker", () => {
  beforeEach(() => listeners.clear());

  it("binds the attested principal to the connection process, then hands the document its end", async () => {
    const { bindPort, port1, port2 } = broker();
    const doc = document();
    request(doc.event);
    await vi.waitFor(() => expect(doc.frame.postMessage).toHaveBeenCalled());
    expect(bindPort).toHaveBeenCalledWith(binding, port1);
    expect(doc.frame.postMessage).toHaveBeenCalledWith(RPC_PORT_GRANT_CHANNEL, {}, [port2]);
  });

  it("refuses a renderer main has no principal for, and a subframe", async () => {
    broker(
      vi.fn(async () => undefined),
      null
    );
    const doc = document();
    request(doc.event);
    await vi.waitFor(() =>
      expect(doc.frame.postMessage).toHaveBeenCalledWith(RPC_PORT_GRANT_CHANNEL, {
        error: "The panel or app is no longer attached.",
      })
    );
    const sub = document();
    request({ sender: sub.contents, senderFrame: { postMessage: vi.fn() } });
    expect(sub.frame.postMessage).not.toHaveBeenCalled();
  });

  it("reports a failed bind to the document and releases the unused port", async () => {
    const { port2 } = broker(vi.fn(async () => Promise.reject(new Error("Control channel ended"))));
    const doc = document();
    request(doc.event);
    await vi.waitFor(() =>
      expect(doc.frame.postMessage).toHaveBeenCalledWith(RPC_PORT_GRANT_CHANNEL, {
        error: "Control channel ended",
      })
    );
    expect(port2.close).toHaveBeenCalled();
  });

  it("tells every holder the exit reason, and refuses later requests with it", async () => {
    const { instance } = broker();
    const doc = document();
    request(doc.event);
    await vi.waitFor(() => expect(doc.frame.postMessage).toHaveBeenCalled());
    instance.connectionLost("The connection process exited unexpectedly (code 9)");
    expect(doc.contents.send).toHaveBeenCalledWith(
      RPC_PORT_LOST_CHANNEL,
      "The connection process exited unexpectedly (code 9)"
    );
    const later = document();
    request(later.event);
    await vi.waitFor(() =>
      expect(later.frame.postMessage).toHaveBeenCalledWith(RPC_PORT_GRANT_CHANNEL, {
        error: "The connection process exited unexpectedly (code 9)",
      })
    );
  });
});

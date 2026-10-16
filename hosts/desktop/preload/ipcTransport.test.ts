import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { ipcRenderer } from "electron";
const emitter = new EventEmitter();
vi.mock("electron", () => ({
  ipcRenderer: {
    on: (...args: Parameters<EventEmitter["on"]>) => emitter.on(...args),
    off: (...args: Parameters<EventEmitter["off"]>) => emitter.off(...args),
    send: vi.fn(),
  },
}));
afterEach(() => {
  emitter.removeAllListeners();
  vi.clearAllMocks();
});

it("settles pending and later recovery with the renderer's original bootstrap failure", async () => {
  const { createIpcTransport } = await import("./ipcTransport");
  const bridge = createIpcTransport();
  emitter.emit("vibestudio:rpc:recovery", {}, "resubscribe", "project", "pending");
  bridge.observeBoot({
    phase: "failed",
    message: "Bundle could not be loaded",
    failureStage: "bundle-load",
  });
  await vi.waitFor(() =>
    expect(ipcRenderer.send).toHaveBeenCalledWith("vibestudio:rpc:recovered", "pending", {
      message: "Bundle could not be loaded",
    })
  );
  emitter.emit("vibestudio:rpc:recovery", {}, "resubscribe", "project", "later");
  await vi.waitFor(() =>
    expect(ipcRenderer.send).toHaveBeenCalledWith("vibestudio:rpc:recovered", "later", {
      message: "Bundle could not be loaded",
    })
  );
});

it("acknowledges only after every renderer recovery handler has settled", async () => {
  const { createIpcTransport } = await import("./ipcTransport");
  const bridge = createIpcTransport();
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  bridge.onRecovery("resubscribe", () => pending);
  const failure = Object.assign(new Error("Replay failed"), { code: "CONNECTION_LOST" });
  bridge.onRecovery("resubscribe", async () => {
    throw failure;
  });
  emitter.emit("vibestudio:rpc:recovery", {}, "resubscribe", "project", "request");
  await Promise.resolve();
  await Promise.resolve();
  expect(ipcRenderer.send).not.toHaveBeenCalled();
  finish();
  await vi.waitFor(() =>
    expect(ipcRenderer.send).toHaveBeenCalledWith("vibestudio:rpc:recovered", "request", {
      message: "Replay failed",
      code: "CONNECTION_LOST",
    })
  );
});

it("waits for runtime registration, including a replacement registration", async () => {
  const { createIpcTransport } = await import("./ipcTransport");
  const bridge = createIpcTransport();
  emitter.emit("vibestudio:rpc:recovery", {}, "cold-recover", "project", "first");
  await Promise.resolve();
  expect(ipcRenderer.send).not.toHaveBeenCalled();
  const handler = vi.fn();
  const stop = bridge.onRecovery("cold-recover", handler);
  await vi.waitFor(() =>
    expect(ipcRenderer.send).toHaveBeenCalledWith("vibestudio:rpc:recovered", "first")
  );
  stop();
  vi.mocked(ipcRenderer.send).mockClear();
  emitter.emit("vibestudio:rpc:recovery", {}, "cold-recover", "project", "second");
  await Promise.resolve();
  expect(ipcRenderer.send).not.toHaveBeenCalled();
  bridge.onRecovery("cold-recover", handler);
  await vi.waitFor(() =>
    expect(ipcRenderer.send).toHaveBeenCalledWith("vibestudio:rpc:recovered", "second")
  );
  expect(handler).toHaveBeenCalledTimes(2);
});
it("delivers workspace-scoped recovery through the shared IPC bridge and releases listeners", async () => {
  const { createIpcTransport } = await import("./ipcTransport");
  const bridge = createIpcTransport();
  const recovered = vi.fn();
  const stop = bridge.onRecovery("cold-recover", recovered);
  emitter.emit("vibestudio:rpc:recovery", {}, "resubscribe", "project");
  expect(recovered).not.toHaveBeenCalled();
  emitter.emit("vibestudio:rpc:recovery", {}, "cold-recover", "project");
  await Promise.resolve();
  expect(recovered).toHaveBeenCalledWith("project");
  stop();
  emitter.emit("vibestudio:rpc:recovery", {}, "cold-recover", "project");
  await Promise.resolve();
  expect(recovered).toHaveBeenCalledTimes(1);
  emitter.removeAllListeners();
});

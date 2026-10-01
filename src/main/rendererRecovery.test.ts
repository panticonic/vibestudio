import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";

const ipc = vi.hoisted(() => ({ on: vi.fn(), off: vi.fn() }));
vi.mock("electron", () => ({ ipcMain: ipc }));
import { recoverRenderer } from "./rendererRecovery.js";

afterEach(() => vi.clearAllMocks());

function renderer() {
  const contents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false,
    send: vi.fn(),
  });
  return contents as unknown as Electron.WebContents & { send: ReturnType<typeof vi.fn> };
}

it("waits for the exact renderer and request, preserving a typed recovery failure", async () => {
  const contents = renderer();
  const pending = recoverRenderer(
    contents,
    "resubscribe",
    "workspace",
    new AbortController().signal
  );
  const id = contents.send.mock.calls[0]![3];
  const receive = ipc.on.mock.calls[0]![1];
  let settled = false;
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  receive({ sender: renderer() }, id);
  receive({ sender: contents }, "previous-generation");
  await Promise.resolve();
  expect(settled).toBe(false);
  receive({ sender: contents }, id, {
    message: "Watch disconnected",
    code: "CONNECTION_LOST",
    errorKind: "transport",
  });
  await expect(pending).rejects.toMatchObject({
    message: "Watch disconnected",
    code: "CONNECTION_LOST",
  });
  expect(ipc.off).toHaveBeenCalledOnce();
  expect(contents.listenerCount("destroyed")).toBe(0);
});

it.each(["destroyed", "render-process-gone"])("settles on %s without a watchdog", async (event) => {
  const contents = renderer();
  const pending = recoverRenderer(
    contents,
    "cold-recover",
    "workspace",
    new AbortController().signal
  );
  contents.emit(event);
  await expect(pending).rejects.toThrow("Renderer ended");
  expect(contents.listenerCount("did-start-navigation")).toBe(0);
});

it("joins cancellation at the owning workspace generation", async () => {
  const contents = renderer();
  const controller = new AbortController();
  const failure = new Error("Workspace retired");
  const pending = recoverRenderer(contents, "resubscribe", "workspace", controller.signal);
  controller.abort(failure);
  await expect(pending).rejects.toBe(failure);
  expect(ipc.off).toHaveBeenCalledOnce();
});

it("settles when navigation replaces its renderer incarnation", async () => {
  const contents = renderer();
  const pending = recoverRenderer(
    contents,
    "resubscribe",
    "workspace",
    new AbortController().signal
  );
  contents.emit("did-start-navigation", {}, "http://localhost/", true, true);
  contents.emit("did-start-navigation", {}, "http://localhost/", false, false);
  contents.emit("did-start-navigation", {}, "http://localhost/", false, true);
  await expect(pending).rejects.toThrow("Renderer replaced");
});

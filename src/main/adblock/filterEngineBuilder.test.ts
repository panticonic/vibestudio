import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("node:worker_threads", () => ({
  Worker: class {
    constructor(...args: unknown[]) {
      return mocks.create(...args);
    }
  },
}));
import { buildFilterEngine } from "./filterEngineBuilder.js";

describe("filter compilation ownership", () => {
  it.each(["message", "error", "exit"] as const)("retires the worker after %s", async (event) => {
    const worker = Object.assign(new EventEmitter(), { terminate: vi.fn(async () => 0) });
    mocks.create.mockReturnValueOnce(worker);
    const build = buildFilterEngine(["https://filters.example/list"]);
    expect(mocks.create).toHaveBeenLastCalledWith(
      expect.stringMatching(/adblock-engine-worker\.cjs$/),
      {
        workerData: ["https://filters.example/list"],
      }
    );
    if (event === "message") {
      const bytes = new Uint8Array([1, 2]);
      worker.emit(event, bytes);
      await expect(build).resolves.toBe(bytes);
    } else {
      const failure = expect(build).rejects.toThrow(
        event === "error" ? "bad filters" : "before delivery"
      );
      worker.emit(event, event === "error" ? new Error("bad filters") : 1);
      await failure;
    }
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});

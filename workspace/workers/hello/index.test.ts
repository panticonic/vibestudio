import { beforeEach, describe, expect, it, vi } from "vitest";

const { expose } = vi.hoisted(() => ({ expose: vi.fn() }));

vi.mock("@workspace/runtime/worker", () => ({
  createWorkerRuntime: () => ({
    rpc: { expose },
    workspace: { sourceTree: vi.fn() },
    fs: { readFile: vi.fn() },
  }),
  handleWorkerRpc: () => null,
}));

import worker, { readNonSecretProbe } from "./index.js";

describe("hello worker env probe", () => {
  beforeEach(() => expose.mockClear());

  it("returns only the fixed non-secret probe binding", () => {
    expect(
      readNonSecretProbe({
        NON_SECRET_PROBE: "configured",
      } as never)
    ).toEqual({ value: "configured" });
    expect(readNonSecretProbe({} as never)).toEqual({ value: null });
  });

  it("exposes readNonSecretProbe when the worker handles a request", async () => {
    await worker.fetch(
      new Request("https://worker.example/"),
      { WORKER_ID: "hello", NON_SECRET_PROBE: "observed" } as never,
      {} as never
    );

    expect(expose).toHaveBeenCalledWith("readNonSecretProbe", expect.any(Function));
    const handler = expose.mock.calls[0]?.[1] as (() => unknown) | undefined;
    expect(handler?.()).toEqual({ value: "observed" });
  });
});

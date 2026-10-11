import { afterEach, describe, expect, it, vi } from "vitest";
import { requestHostHttp, withPublicHostHttp } from "./hostHttpTransport.js";

const agentState = vi.hoisted(() => ({ destroy: vi.fn(async () => {}), options: [] as unknown[] }));
vi.mock("undici", () => ({
  Agent: class {
    constructor(options: unknown) {
      agentState.options.push(options);
    }
    destroy() {
      return agentState.destroy();
    }
  },
}));

afterEach(() => vi.unstubAllGlobals());

describe("host HTTP transport", () => {
  it("uses the caller-owned dispatcher and never follows redirects implicitly", async () => {
    const response = new Response("redirect", {
      status: 302,
      headers: { location: "https://redirect.test/" },
    });
    const fetch = vi.fn(async () => response);
    vi.stubGlobal("fetch", fetch);
    const dispatcher = {} as Parameters<typeof requestHostHttp>[0]["dispatcher"];
    const signal = new AbortController().signal;

    await expect(
      requestHostHttp({
        url: new URL("https://example.test/repo.git/info/refs?service=git-upload-pack"),
        method: "GET",
        headers: {},
        signal,
        dispatcher,
      })
    ).resolves.toBe(response);

    expect(fetch).toHaveBeenCalledWith(
      "https://example.test/repo.git/info/refs?service=git-upload-pack",
      expect.objectContaining({ redirect: "manual", dispatcher, signal })
    );
  });

  it("rejects private destinations before making an HTTP request", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    await expect(
      withPublicHostHttp(
        {
          url: new URL("http://127.0.0.1/private.git/info/refs?service=git-upload-pack"),
          method: "GET",
          headers: {},
          signal: new AbortController().signal,
        },
        async (response) => response.status
      )
    ).rejects.toThrow(/outside the authorized address space/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("propagates cancellation and joins the owned dispatcher before settling", async () => {
    const signalController = new AbortController();
    const canceled = new Error("bootstrap canceled");
    agentState.destroy.mockClear();
    agentState.options.length = 0;
    const fetch = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        })
    );
    vi.stubGlobal("fetch", fetch);
    const pending = withPublicHostHttp(
      {
        url: new URL("https://8.8.8.8/repo.git/info/refs?service=git-upload-pack"),
        method: "GET",
        headers: {},
        signal: signalController.signal,
      },
      async (response) => response.status
    );
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    signalController.abort(canceled);

    await expect(pending).rejects.toBe(canceled);
    expect(agentState.destroy).toHaveBeenCalledOnce();
    expect(agentState.options).toEqual([
      expect.objectContaining({
        pipelining: 0,
        headersTimeout: 0,
        bodyTimeout: 0,
        connect: { lookup: expect.any(Function) },
      }),
    ]);
  });

  it("preserves both transport and dispatcher cleanup failures", async () => {
    const transportFailure = new Error("request failed");
    const cleanupFailure = new Error("dispatcher cleanup failed");
    agentState.destroy.mockRejectedValueOnce(cleanupFailure);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(transportFailure))
    );

    let failure: unknown;
    try {
      await withPublicHostHttp(
        {
          url: new URL("https://8.8.8.8/repo.git/info/refs?service=git-upload-pack"),
          method: "GET",
          headers: {},
          signal: new AbortController().signal,
        },
        async (response) => response.status
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure).toMatchObject({ cause: transportFailure });
    expect((failure as AggregateError).errors).toEqual([transportFailure, cleanupFailure]);
  });
});

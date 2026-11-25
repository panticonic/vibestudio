import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isProvenPreconnectFailure,
  requestHostHttp,
  withPublicHostHttp,
} from "./hostHttpTransport.js";

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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

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

function connectError(code = "ETIMEDOUT") {
  return Object.assign(new Error("connect failure"), { code, syscall: "connect" });
}
function aggregateConnect() {
  return new TypeError("fetch failed", {
    cause: new AggregateError([connectError(), connectError("ENETUNREACH")]),
  });
}
function input(body?: BodyInit) {
  return {
    url: new URL("https://example.test/model"),
    method: "POST",
    headers: { authorization: "Bearer private" },
    body,
    signal: new AbortController().signal,
    dispatcher: {} as Parameters<typeof requestHostHttp>[0]["dispatcher"],
  };
}

describe("proven preconnect HTTP retry", () => {
  it("retries the real multi-address shape once with stable bytes and the same checked dispatcher", async () => {
    const bytes = new Uint8Array([1, 2, 3]),
      request = input(bytes);
    const response = new Response("actual response");
    const fetch = vi
      .fn()
      .mockImplementationOnce(async () => {
        bytes.fill(9);
        throw aggregateConnect();
      })
      .mockResolvedValueOnce(response);
    vi.stubGlobal("fetch", fetch);
    await expect(requestHostHttp(request)).resolves.toBe(response);
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const [url, options] of fetch.mock.calls) {
      expect(url).toBe(request.url.href);
      expect(options.dispatcher).toBe(request.dispatcher);
      expect(options.signal).toBe(request.signal);
      expect(options.redirect).toBe("manual");
      expect([...options.body]).toEqual([1, 2, 3]);
    }
  });
  it("propagates the original final error after the single retry", async () => {
    const first = aggregateConnect(),
      last = connectError();
    const fetch = vi.fn().mockRejectedValueOnce(first).mockRejectedValueOnce(last);
    vi.stubGlobal("fetch", fetch);
    await expect(requestHostHttp(input("actual request"))).rejects.toBe(last);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it.each([
    new TypeError("fetch failed"),
    new TypeError("fetch failed", {
      cause: Object.assign(new Error("socket reset"), { code: "ECONNRESET", syscall: "read" }),
    }),
    new TypeError("fetch failed", {
      cause: new AggregateError([
        connectError(),
        Object.assign(new Error("TLS"), { code: "CERT_HAS_EXPIRED" }),
      ]),
    }),
    Object.assign(new Error("aborted"), {
      name: "AbortError",
      code: "ETIMEDOUT",
      syscall: "connect",
    }),
    Object.assign(new Error("ambiguous timeout"), { code: "ETIMEDOUT" }),
    new AggregateError([]),
  ])("does not replay ambiguous, mixed, body, TLS or abort errors: %s", async (error) => {
    const fetch = vi.fn().mockRejectedValue(error);
    vi.stubGlobal("fetch", fetch);
    await expect(requestHostHttp(input("request"))).rejects.toBe(error);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("never replays streamed or multipart request bodies", async () => {
    const error = aggregateConnect(),
      fetch = vi.fn().mockRejectedValue(error);
    vi.stubGlobal("fetch", fetch);
    for (const body of [new ReadableStream(), new FormData()])
      await expect(requestHostHttp(input(body))).rejects.toBe(error);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("does not retry any HTTP response or a subsequent body failure", async () => {
    const error = Object.assign(new Error("body reset"), { code: "ECONNRESET", syscall: "read" });
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response("server error", { status: 500 }))
      .mockResolvedValueOnce(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(error);
            },
          })
        )
      );
    vi.stubGlobal("fetch", fetch);
    expect((await requestHostHttp(input("request"))).status).toBe(500);
    const response = await requestHostHttp(input("request"));
    await expect(response.text()).rejects.toBe(error);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("honors abort after a failed connection without replaying", async () => {
    const controller = new AbortController(),
      request = { ...input(), signal: controller.signal },
      error = aggregateConnect();
    const fetch = vi.fn(async () => {
      controller.abort();
      throw error;
    });
    vi.stubGlobal("fetch", fetch);
    await expect(requestHostHttp(request)).rejects.toBe(error);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("honors explicit opt-out and enclosing retry ownership", async () => {
    const error = aggregateConnect(),
      fetch = vi.fn().mockRejectedValue(error);
    vi.stubGlobal("fetch", fetch);
    vi.stubEnv("VIBESTUDIO_HTTP_PRECONNECT_RETRY", "0");
    await expect(requestHostHttp(input())).rejects.toBe(error);
    vi.unstubAllEnvs();
    await expect(requestHostHttp({ ...input(), retryPreconnect: false })).rejects.toBe(error);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("requires all authoritative leaves and refuses cyclic or accessor-backed proof", () => {
    expect(isProvenPreconnectFailure(aggregateConnect())).toBe(true);
    expect(
      isProvenPreconnectFailure(
        Object.assign(new Error("temporary DNS"), { code: "EAI_AGAIN", syscall: "getaddrinfo" })
      )
    ).toBe(true);
    const cycle = connectError();
    Object.assign(cycle, { cause: cycle });
    expect(isProvenPreconnectFailure(cycle)).toBe(false);
    let getters = 0;
    const accessor = connectError();
    Object.defineProperty(accessor, "cause", {
      get() {
        getters++;
        throw Error("must not run");
      },
    });
    expect(isProvenPreconnectFailure(accessor)).toBe(false);
    expect(getters).toBe(0);
    expect(isProvenPreconnectFailure({ code: "ETIMEDOUT", syscall: "connect" })).toBe(false);
  });
});

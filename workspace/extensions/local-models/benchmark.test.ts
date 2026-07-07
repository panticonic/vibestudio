import { describe, expect, it, vi } from "vitest";
import { parseBenchmarkThroughput, runModelBenchmark, type ModelBenchmarkDeps } from "./benchmark.js";

describe("local model benchmark", () => {
  it("stores llama.cpp timings.predicted_per_second when present", async () => {
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      expect(String(input)).toBe("http://127.0.0.1:49152/v1/chat/completions");
      const body = JSON.parse(String(init?.body)) as {
        model?: string;
        messages?: unknown[];
        max_tokens?: number;
        stream?: boolean;
      };
      expect(body).toMatchObject({
        model: "toy",
        max_tokens: 128,
        stream: false,
      });
      expect(body.messages).toEqual([
        { role: "user", content: "Write a short paragraph about the ocean." },
      ]);
      return jsonResponse({
        timings: { predicted_per_second: 37.25 },
        usage: { completion_tokens: 4 },
      });
    });
    const setBenchmark = vi.fn(async () => {});
    const result = await runModelBenchmark("toy", deps({ fetchMock, setBenchmark, now: sequenceNow(1000, 1400, 1500) }));

    expect(result).toEqual({ tokensPerSec: 37.25 });
    expect(setBenchmark).toHaveBeenCalledWith("toy", { tokensPerSec: 37.25, measuredAt: 1500 });
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: "Bearer loopback-key",
    });
  });

  it("falls back to completion_tokens divided by elapsed seconds", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        usage: { completion_tokens: 64 },
      })
    );
    const setBenchmark = vi.fn(async () => {});

    const result = await runModelBenchmark("toy", deps({ fetchMock, setBenchmark, now: sequenceNow(1000, 3000, 3000) }));

    expect(result).toEqual({ tokensPerSec: 32 });
    expect(setBenchmark).toHaveBeenCalledWith("toy", { tokensPerSec: 32, measuredAt: 3000 });
    expect(parseBenchmarkThroughput({ usage: { completion_tokens: 64 } }, 2)).toBe(32);
  });

  it("logs and returns null when throughput cannot be parsed", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ usage: { completion_tokens: 0 } }));
    const setBenchmark = vi.fn(async () => {});
    const log = vi.fn();

    await expect(runModelBenchmark("toy", deps({ fetchMock, setBenchmark, log }))).resolves.toBeNull();
    expect(setBenchmark).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("benchmark failed", expect.objectContaining({ slug: "toy" }));
  });
});

function deps(input: {
  fetchMock: ReturnType<typeof vi.fn>;
  setBenchmark: ReturnType<typeof vi.fn>;
  now?: () => number;
  log?: ReturnType<typeof vi.fn>;
}): ModelBenchmarkDeps {
  return {
    fetch: input.fetchMock as unknown as typeof fetch,
    ensureLoaded: vi.fn(async () => ({ baseUrl: "http://127.0.0.1:49152/v1" })),
    apiKey: vi.fn(async () => "loopback-key"),
    setBenchmark: input.setBenchmark as unknown as ModelBenchmarkDeps["setBenchmark"],
    now: input.now ?? sequenceNow(1000, 1001, 1002),
    log: (input.log ?? vi.fn()) as ModelBenchmarkDeps["log"],
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
  });
}

function sequenceNow(...values: number[]): () => number {
  let index = 0;
  return () => {
    const value = values[Math.min(index, values.length - 1)];
    index += 1;
    return value ?? 0;
  };
}

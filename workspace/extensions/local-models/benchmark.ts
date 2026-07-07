import type { ModelBenchmarkResult } from "./types.js";

export interface ModelBenchmarkDeps {
  fetch: typeof fetch;
  ensureLoaded(slug: string): Promise<{ baseUrl: string }>;
  apiKey(): Promise<string>;
  setBenchmark(slug: string, result: ModelBenchmarkResult): Promise<void>;
  now(): number;
  log(msg: string, data?: unknown): void;
}

const BENCHMARK_MESSAGES = [
  { role: "user", content: "Write a short paragraph about the ocean." },
] as const;

export async function runModelBenchmark(
  slug: string,
  deps: ModelBenchmarkDeps
): Promise<{ tokensPerSec: number } | null> {
  try {
    const [{ baseUrl }, apiKey] = await Promise.all([deps.ensureLoaded(slug), deps.apiKey()]);
    const startedAt = deps.now();
    const response = await deps.fetch(`${trimTrailingSlash(baseUrl)}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: slug,
        messages: BENCHMARK_MESSAGES,
        max_tokens: 128,
        stream: false,
      }),
    });
    const elapsedSeconds = Math.max(0, (deps.now() - startedAt) / 1000);

    if (!response.ok) {
      throw new Error(`benchmark completion failed with HTTP ${response.status}`);
    }

    const body = (await response.json()) as unknown;
    const tokensPerSec = parseBenchmarkThroughput(body, elapsedSeconds);
    if (tokensPerSec === null) {
      throw new Error("benchmark completion did not include usable throughput metadata");
    }

    const result: ModelBenchmarkResult = {
      tokensPerSec,
      measuredAt: deps.now(),
    };
    await deps.setBenchmark(slug, result);
    deps.log("benchmark complete", { slug, tokensPerSec });
    return { tokensPerSec };
  } catch (error) {
    deps.log("benchmark failed", { slug, error: errorMessage(error) });
    return null;
  }
}

export function parseBenchmarkThroughput(body: unknown, elapsedSeconds: number): number | null {
  const root = asRecord(body);
  const timings = asRecord(root?.["timings"]);
  const reported = numberValue(timings?.["predicted_per_second"]);
  if (reported !== null && reported > 0) {
    return reported;
  }

  const usage = asRecord(root?.["usage"]);
  const completionTokens =
    numberValue(usage?.["completion_tokens"]) ?? numberValue(usage?.["completionTokens"]);
  if (completionTokens === null || completionTokens <= 0 || elapsedSeconds <= 0) {
    return null;
  }
  return completionTokens / elapsedSeconds;
}

function trimTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

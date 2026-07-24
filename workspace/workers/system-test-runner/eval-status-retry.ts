const MAX_TRANSIENT_STATUS_READS = 10;
const STATUS_RETRY_DELAY_MS = 500;

function errorText(error: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();
  let cursor: unknown = error;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    if (cursor instanceof Error) parts.push(cursor.message);
    else if (typeof cursor === "string") parts.push(cursor);
    if (!cursor || typeof cursor !== "object") break;
    const record = cursor as Record<string, unknown>;
    for (const key of ["code", "errorKind"] as const) {
      if (typeof record[key] === "string") parts.push(record[key]);
    }
    cursor = record["cause"];
  }
  return parts.join(" ");
}

export function isTransientEvalStatusReadError(error: unknown): boolean {
  return /(?:DO dispatch fetch|fetch failed|other side closed|socket hang up|UND_ERR_SOCKET|ECONNRESET|ECONNREFUSED|ETIMEDOUT|\btransport\b)/iu.test(
    errorText(error)
  );
}

export async function readEvalStatusWithRetry<T>(
  read: () => Promise<T>,
  deps: {
    pause?: (ms: number) => Promise<void>;
    maxAttempts?: number;
    retryDelayMs?: number;
  } = {}
): Promise<T> {
  const pause =
    deps.pause ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const maxAttempts = deps.maxAttempts ?? MAX_TRANSIENT_STATUS_READS;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await read();
    } catch (error) {
      if (attempt >= maxAttempts || !isTransientEvalStatusReadError(error)) throw error;
      await pause(deps.retryDelayMs ?? STATUS_RETRY_DELAY_MS);
    }
  }
}

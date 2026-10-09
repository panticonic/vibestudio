import type { IncomingMessage, ServerResponse } from "node:http";

/** A JSON API response. API payloads are never cacheable. */
export function sendJson(
  res: ServerResponse,
  status: number,
  payload: unknown,
  headers: Record<string, string> = {}
): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(JSON.stringify(payload));
}

export function sendText(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(body);
}

/**
 * The request body, refusing to buffer more than the route's `maxBytes`.
 * `tooLarge` builds the route's own error so callers keep their wire codes.
 */
export async function readBoundedBody(
  req: IncomingMessage,
  maxBytes: number,
  tooLarge: () => Error
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const raw of req) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as string);
    total += chunk.byteLength;
    if (total > maxBytes) throw tooLarge();
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

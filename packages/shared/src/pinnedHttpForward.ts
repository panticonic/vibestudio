import {
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
  type OutgoingHttpHeaders,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { pinnedConnectionOptions, type NetworkDestination } from "./networkDestination.js";
export interface ForwardResult {
  statusCode: number;
  bytesIn: number;
  bytesOut: number;
}
/** Stream through one vetted DNS snapshot; Chromium retains responsibility for navigation and TLS. */
export async function forwardPinnedHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  targetUrl: URL,
  headers: OutgoingHttpHeaders,
  destination: NetworkDestination,
  signal: AbortSignal
): Promise<ForwardResult> {
  return new Promise<ForwardResult>((resolve, reject) => {
    const requestFn = targetUrl.protocol === "https:" ? httpsRequest : httpRequest;
    const defaultPort = targetUrl.protocol === "https:" ? 443 : 80;
    let statusCode = 502;
    let bytesIn = 0;
    let bytesOut = 0;
    let settled = false;

    const upstreamRequest = requestFn(
      {
        protocol: targetUrl.protocol,
        hostname: destination.hostname,
        ...pinnedConnectionOptions(destination),
        agent: false,
        signal,
        port: targetUrl.port ? Number(targetUrl.port) : defaultPort,
        method: req.method ?? "GET",
        path: `${targetUrl.pathname}${targetUrl.search}`,
        headers,
      },
      (upstreamResponse) => {
        statusCode = upstreamResponse.statusCode ?? 502;
        res.writeHead(statusCode, upstreamResponse.headers);
        // `writeHead` only queues the head; it is sent with the first body
        // chunk. A held response (an RPC whose server flushes its head to
        // acknowledge admission and answers much later) must reach the caller
        // now: its cancellation is ordered after that acknowledgement.
        res.flushHeaders();
        upstreamResponse.on("data", (chunk: Buffer | string) => {
          bytesIn += Buffer.byteLength(chunk);
        });
        upstreamResponse.on("error", reject);
        res.on("finish", () => {
          if (!settled) {
            settled = true;
            resolve({ statusCode, bytesIn, bytesOut });
          }
        });
        res.on("close", () => {
          upstreamRequest.destroy();
          if (!settled) {
            settled = true;
            resolve({ statusCode, bytesIn, bytesOut });
          }
        });
        upstreamResponse.pipe(res);
      }
    );

    upstreamRequest.on("error", reject);
    req.on("error", reject);
    res.on("error", () => {
      upstreamRequest.destroy();
    });
    req.on("data", (chunk: Buffer | string) => {
      bytesOut += Buffer.byteLength(chunk);
    });
    req.pipe(upstreamRequest);
  });
}

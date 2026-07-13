import type { ProxyGitHttpResponse } from "../../../packages/shared/src/credentials/types.js";

export interface GitHttpTransportResponse {
  url: string;
  method: string;
  statusCode: number;
  statusMessage: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

/** Convert the host transport response to the public, JSON-safe RPC shape. */
export function serializeGitHttpResponse(response: GitHttpTransportResponse): ProxyGitHttpResponse {
  return {
    url: response.url,
    method: response.method,
    statusCode: response.statusCode,
    statusMessage: response.statusMessage,
    headers: response.headers,
    bodyBase64: Buffer.from(response.body).toString("base64"),
  };
}

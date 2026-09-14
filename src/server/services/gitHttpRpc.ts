export interface GitHttpTransportResponse {
  url: string;
  method: string;
  statusCode: number;
  statusMessage: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

/** Keep Git pack bytes on the streaming RPC lane instead of a control envelope. */
export function createGitHttpResponse(response: GitHttpTransportResponse): Response {
  return new Response(Buffer.from(response.body), {
    status: response.statusCode,
    statusText: response.statusMessage,
    headers: response.headers,
  });
}

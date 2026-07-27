import type { ClientPlatform } from "./wsProtocol.js";

export const RPC_WEBSOCKET_ADMISSION_PATH = "/rpc/ws-admission";
export const RPC_CLIENT_LABEL_HEADER = "x-vibestudio-rpc-client-label";
export const RPC_CLIENT_PLATFORM_HEADER = "x-vibestudio-rpc-client-platform";

export function encodeRpcClientLabelHeader(label: string): string {
  return encodeURIComponent(label);
}

export function decodeRpcClientLabelHeader(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return encodeRpcClientLabelHeader(decoded) === value ? decoded : null;
  } catch {
    return null;
  }
}

export interface RpcWebSocketAdmissionRequest {
  credential: string;
  clientLabel?: string;
  clientPlatform?: ClientPlatform;
}

export interface RpcWebSocketAdmissionSuccess {
  ok: true;
  grant: string;
  expiresAt: number;
}

export type RpcWebSocketAdmissionFailureCode =
  | "invalid_credential"
  | "admin_credential"
  | "admission_saturated"
  | "invalid_request"
  | "server_unavailable";

export interface RpcWebSocketAdmissionFailure {
  ok: false;
  code: RpcWebSocketAdmissionFailureCode;
  message: string;
  retryAfterMs?: number;
}

export type RpcWebSocketAdmissionResponse =
  | RpcWebSocketAdmissionSuccess
  | RpcWebSocketAdmissionFailure;

const FAILURE_CODES = new Set<RpcWebSocketAdmissionFailureCode>([
  "invalid_credential",
  "admin_credential",
  "admission_saturated",
  "invalid_request",
  "server_unavailable",
]);

function isFailureCode(value: string): value is RpcWebSocketAdmissionFailureCode {
  return FAILURE_CODES.has(value as RpcWebSocketAdmissionFailureCode);
}

export function rpcWebSocketAdmissionUrl(webSocketUrl: string): string {
  const url = new URL(webSocketUrl);
  if (url.protocol === "ws:") url.protocol = "http:";
  else if (url.protocol === "wss:") url.protocol = "https:";
  else throw new Error(`Unsupported RPC WebSocket URL protocol: ${url.protocol}`);
  url.pathname = url.pathname.endsWith("/rpc")
    ? `${url.pathname}/ws-admission`
    : RPC_WEBSOCKET_ADMISSION_PATH;
  url.search = "";
  url.hash = "";
  return url.toString();
}

export async function requestRpcWebSocketAdmission(
  url: string,
  request: RpcWebSocketAdmissionRequest
): Promise<RpcWebSocketAdmissionResponse> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${request.credential}`,
      ...(request.clientLabel
        ? { [RPC_CLIENT_LABEL_HEADER]: encodeRpcClientLabelHeader(request.clientLabel) }
        : {}),
      ...(request.clientPlatform ? { [RPC_CLIENT_PLATFORM_HEADER]: request.clientPlatform } : {}),
    },
  });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error(`RPC WebSocket admission returned non-JSON HTTP ${response.status}`);
  }
  if (!body || typeof body !== "object" || !("ok" in body)) {
    throw new Error(`RPC WebSocket admission returned malformed HTTP ${response.status}`);
  }
  const result = body as Partial<RpcWebSocketAdmissionResponse>;
  if (
    result.ok === true &&
    typeof result.grant === "string" &&
    typeof result.expiresAt === "number"
  ) {
    return { ok: true, grant: result.grant, expiresAt: result.expiresAt };
  }
  if (
    result.ok === false &&
    typeof result.code === "string" &&
    isFailureCode(result.code) &&
    typeof result.message === "string"
  ) {
    return {
      ok: false,
      code: result.code,
      message: result.message,
      ...(typeof result.retryAfterMs === "number" ? { retryAfterMs: result.retryAfterMs } : {}),
    };
  }
  throw new Error(`RPC WebSocket admission returned malformed HTTP ${response.status}`);
}

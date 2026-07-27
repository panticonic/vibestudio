import type { ClientPlatform } from "./wsProtocol.js";

export const RPC_WEBSOCKET_ADMISSION_PATH = "/rpc/ws-admission";
export const RPC_CLIENT_LABEL_HEADER = "x-vibestudio-rpc-client-label";
export const RPC_CLIENT_PLATFORM_HEADER = "x-vibestudio-rpc-client-platform";
export const RPC_WEBSOCKET_ADMISSION_TIMEOUT_MS = 10_000;

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

/**
 * Empty optional metadata has one wire representation: absent. Keeping this
 * normalization shared prevents admission headers and the subsequent auth
 * frame from binding different values for the same client.
 */
export function normalizeRpcClientLabel(label: string | undefined): string | undefined {
  return label === undefined || label.length === 0 ? undefined : label;
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
  request: RpcWebSocketAdmissionRequest,
  options: { signal?: AbortSignal; timeoutMs?: number } = {}
): Promise<RpcWebSocketAdmissionResponse> {
  const timeoutMs = options.timeoutMs ?? RPC_WEBSOCKET_ADMISSION_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError("RPC WebSocket admission timeout must be a positive finite number");
  }
  const controller = new AbortController();
  let timedOut = false;
  const forwardAbort = (): void => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) forwardAbort();
  else options.signal?.addEventListener("abort", forwardAbort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error(`RPC WebSocket admission timed out after ${timeoutMs}ms`));
  }, timeoutMs);

  let response: Response;
  try {
    const clientLabel = normalizeRpcClientLabel(request.clientLabel);
    response = await fetch(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${request.credential}`,
        ...(clientLabel
          ? { [RPC_CLIENT_LABEL_HEADER]: encodeRpcClientLabelHeader(clientLabel) }
          : {}),
        ...(request.clientPlatform ? { [RPC_CLIENT_PLATFORM_HEADER]: request.clientPlatform } : {}),
      },
    });
  } catch (error) {
    if (timedOut) {
      throw new Error(`RPC WebSocket admission timed out after ${timeoutMs}ms`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", forwardAbort);
  }
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

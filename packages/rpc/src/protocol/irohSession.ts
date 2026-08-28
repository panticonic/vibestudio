import { IROH_WIRE_VERSION } from "@vibestudio/iroh-transport";
import type { CallerKind } from "../types.js";
import type {
  ClientPlatform,
  DeviceCredential,
  OAuthCallbackMode,
  PairingContext,
  RpcAuthenticationFailureCode,
} from "./wsProtocol.js";

export const IROH_SESSION_HELLO = "hello" as const;
export const IROH_SESSION_OPEN = "open" as const;
export const IROH_SESSION_OPEN_RESULT = "open-result" as const;
export const IROH_SESSION_CLOSE = "close" as const;
export const IROH_SESSION_CLOSED = "closed" as const;

export interface IrohSessionHelloFrame {
  t: typeof IROH_SESSION_HELLO;
  protocolVersion: typeof IROH_WIRE_VERSION;
  contractVersion: number;
}

export interface IrohSessionOpenFrame {
  t: typeof IROH_SESSION_OPEN;
  sid: string;
  token: string;
  connectionId?: string;
  clientSessionId?: string;
  clientLabel?: string;
  clientPlatform?: ClientPlatform;
  oauthCallbackMode?: OAuthCallbackMode;
}

export interface IrohSessionOpenResultFrame {
  t: typeof IROH_SESSION_OPEN_RESULT;
  sid: string;
  success: boolean;
  callerId?: string;
  callerKind?: CallerKind;
  connectionId?: string;
  serverBootId?: string;
  sessionDirty?: boolean;
  deviceCredential?: DeviceCredential;
  pairingContext?: PairingContext;
  error?: string;
  errorCode?: RpcAuthenticationFailureCode;
  terminal?: boolean;
}

export interface IrohSessionCloseFrame {
  t: typeof IROH_SESSION_CLOSE;
  sid: string;
  code?: number;
  reason?: string;
}

export interface IrohSessionClosedFrame {
  t: typeof IROH_SESSION_CLOSED;
  sid: string;
  code?: number;
  reason?: string;
  terminal?: boolean;
}

export type IrohSessionControlFrame =
  | IrohSessionHelloFrame
  | IrohSessionOpenFrame
  | IrohSessionOpenResultFrame
  | IrohSessionCloseFrame
  | IrohSessionClosedFrame;

const CONTROL_TAGS = new Set<string>([
  IROH_SESSION_HELLO,
  IROH_SESSION_OPEN,
  IROH_SESSION_OPEN_RESULT,
  IROH_SESSION_CLOSE,
  IROH_SESSION_CLOSED,
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function assertOptionalString(record: Record<string, unknown>, key: string): void {
  if (record[key] !== undefined && typeof record[key] !== "string") {
    throw new Error(`Iroh session frame '${String(record["t"])}' has invalid ${key}`);
  }
}

export function encodeIrohSessionControlFrame(frame: IrohSessionControlFrame): Uint8Array {
  assertIrohSessionControlFrame(frame);
  return new TextEncoder().encode(JSON.stringify(frame));
}

export function decodeIrohSessionControlFrame(bytes: Uint8Array): IrohSessionControlFrame {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error("Invalid Iroh session control JSON", { cause: error });
  }
  assertIrohSessionControlFrame(value);
  return value;
}

export function assertIrohSessionControlFrame(
  value: unknown
): asserts value is IrohSessionControlFrame {
  if (!isRecord(value) || typeof value["t"] !== "string" || !CONTROL_TAGS.has(value["t"])) {
    throw new Error("Unknown or malformed Iroh session control frame");
  }
  const tag = value["t"];
  if (tag === IROH_SESSION_HELLO) {
    if (
      value["protocolVersion"] !== IROH_WIRE_VERSION ||
      !Number.isSafeInteger(value["contractVersion"])
    ) {
      throw new Error("Iroh session hello has an incompatible protocol or contract version");
    }
    return;
  }
  if (typeof value["sid"] !== "string" || value["sid"].length === 0) {
    throw new Error(`Iroh session frame '${tag}' is missing sid`);
  }
  if (tag === IROH_SESSION_OPEN) {
    if (typeof value["token"] !== "string" || value["token"].length === 0) {
      throw new Error("Iroh session open is missing token");
    }
    for (const key of [
      "connectionId",
      "clientSessionId",
      "clientLabel",
      "clientPlatform",
      "oauthCallbackMode",
    ]) {
      assertOptionalString(value, key);
    }
    return;
  }
  if (tag === IROH_SESSION_OPEN_RESULT) {
    if (typeof value["success"] !== "boolean") {
      throw new Error("Iroh session open-result is missing success");
    }
    return;
  }
  assertOptionalString(value, "reason");
  if (value["code"] !== undefined && !Number.isSafeInteger(value["code"])) {
    throw new Error(`Iroh session frame '${tag}' has invalid code`);
  }
  if (tag === IROH_SESSION_CLOSED && value["terminal"] !== undefined) {
    if (typeof value["terminal"] !== "boolean") {
      throw new Error("Iroh session closed has invalid terminal flag");
    }
  }
}

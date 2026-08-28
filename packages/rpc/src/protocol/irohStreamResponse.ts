import type { RpcErrorData, RpcErrorKind } from "../types.js";

export interface IrohStreamResponseHead {
  status: number;
  statusText: string;
  headerPairs: Array<[string, string]>;
  finalUrl: string;
  error?: {
    message: string;
    errorKind: RpcErrorKind;
    code?: string;
    errorData?: RpcErrorData;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function encodeIrohStreamResponseHead(head: IrohStreamResponseHead): Uint8Array {
  assertIrohStreamResponseHead(head);
  return new TextEncoder().encode(JSON.stringify(head));
}

export function decodeIrohStreamResponseHead(bytes: Uint8Array): IrohStreamResponseHead {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error("Invalid Iroh streaming response head JSON", { cause: error });
  }
  assertIrohStreamResponseHead(value);
  return value;
}

export function assertIrohStreamResponseHead(
  value: unknown
): asserts value is IrohStreamResponseHead {
  if (
    !isRecord(value) ||
    !Number.isSafeInteger(value["status"]) ||
    (value["status"] as number) < 100 ||
    (value["status"] as number) > 599 ||
    typeof value["statusText"] !== "string" ||
    typeof value["finalUrl"] !== "string" ||
    !Array.isArray(value["headerPairs"]) ||
    !value["headerPairs"].every(
      (pair) =>
        Array.isArray(pair) &&
        pair.length === 2 &&
        typeof pair[0] === "string" &&
        typeof pair[1] === "string"
    )
  ) {
    throw new Error("Malformed Iroh streaming response head");
  }
  if (value["error"] !== undefined) {
    const error = value["error"];
    if (
      !isRecord(error) ||
      typeof error["message"] !== "string" ||
      typeof error["errorKind"] !== "string" ||
      (error["code"] !== undefined && typeof error["code"] !== "string")
    ) {
      throw new Error("Malformed Iroh streaming response error");
    }
  }
}

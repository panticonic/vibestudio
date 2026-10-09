import { z } from "zod";
import { rpcBytesOf } from "@vibestudio/rpc";

/**
 * Native RPC bytes. The RPC wire codec (`@vibestudio/rpc` encodeRpcJson /
 * decodeRpcJson) carries `Uint8Array` (including Node `Buffer`) and
 * `ArrayBuffer` values natively, so service schemas declare bytes with this
 * type instead of a hand-written base64 envelope. An `ArrayBuffer` argument is
 * normalized to a `Uint8Array`.
 */
export const BYTES_TYPE_NAME = "VibestudioBytes";

export interface ZodBytesDef extends z.ZodTypeDef {
  typeName: typeof BYTES_TYPE_NAME;
}

export class ZodBytes extends z.ZodType<Uint8Array, ZodBytesDef, Uint8Array | ArrayBuffer> {
  _parse(input: z.ParseInput): z.ParseReturnType<Uint8Array> {
    const bytes = rpcBytesOf(input.data);
    if (bytes) return z.OK(bytes);
    const ctx = this._getOrReturnCtx(input);
    z.addIssueToContext(ctx, {
      code: z.ZodIssueCode.custom,
      message: "Expected bytes (Uint8Array or ArrayBuffer)",
    });
    return z.INVALID;
  }
}

export const ByteArraySchema = new ZodBytes({ typeName: BYTES_TYPE_NAME });

/** The JSON-Schema rendering of {@link ByteArraySchema} for catalogs and `help()`. */
export const BYTES_JSON_SCHEMA = Object.freeze({
  type: "string",
  format: "binary",
} as const);

/**
 * `zod-to-json-schema` `postProcess` hook: renders {@link ZodBytes} (which the
 * converter does not know) as {@link BYTES_JSON_SCHEMA}, keeping its description.
 * Every zod → JSON-Schema conversion of service schemas passes this hook.
 */
export function renderBytesJsonSchema<T>(
  jsonSchema: T,
  def: { typeName?: unknown; description?: unknown }
): T | { type: "string"; format: "binary"; description?: string } {
  if (def.typeName !== BYTES_TYPE_NAME) return jsonSchema;
  return {
    ...BYTES_JSON_SCHEMA,
    ...(typeof def.description === "string" ? { description: def.description } : {}),
  };
}

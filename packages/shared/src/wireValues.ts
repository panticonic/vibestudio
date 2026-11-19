import { z } from "zod";
import { ByteArraySchema } from "./binary.js";

/** Values that can cross a JSON RPC boundary without lossy coercion. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(JsonValueSchema),
  ])
);

export const JsonObjectSchema = z.record(JsonValueSchema);

/** Open-ended RPC results may carry bytes at any depth. */
export type RpcValue =
  | string
  | number
  | boolean
  | null
  | Uint8Array
  | RpcValue[]
  | { [key: string]: RpcValue };

export const RpcValueSchema: z.ZodType<RpcValue, z.ZodTypeDef, unknown> = z.lazy(() =>
  z.union([
    ByteArraySchema,
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(RpcValueSchema),
    z.record(RpcValueSchema),
  ])
);

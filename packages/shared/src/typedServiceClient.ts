/**
 * Typed service client — derives a fully typed call surface from a service's
 * Zod method schema table.
 *
 * Service method tables (`packages/service-schemas/src/<service>.ts`)
 * are the single source of truth for a service's wire contract: argument
 * tuples, optional return schemas, and per-method policies. The server
 * attaches handlers to them; clients derive their types from them. Nothing
 * is hand-duplicated.
 *
 * - Argument types come from `z.infer` of the method's `args` tuple, with
 *   trailing `| undefined` elements relaxed to optional parameters so
 *   `client.logs("unit")` works when the options argument is optional.
 * - Return types come from `z.infer` of the method's `returns` schema when
 *   declared, `unknown` otherwise (callers should add `returns` schemas
 *   rather than cast).
 * - Dotted method names (`"units.list"`) become nested objects
 *   (`client.units.list(...)`).
 */

import type { z } from "zod";
import type { ServicePolicy, MethodAccessDescriptor } from "./servicePolicy.js";

/** A worked example for a method. Realistic values allowed (hand-authored or
 *  redacted-from-real-usage); flows to the capability catalog and JIT errors. */
export interface MethodExample {
  args: unknown[];
  returns?: unknown;
  note?: string;
}

/** A documented error outcome a method may throw. */
export interface MethodError {
  /** Stable code (e.g. "ENOENT", "EACCES") or a domain code. */
  code: string;
  description: string;
}

/**
 * Pure-data schema for one RPC method (no handler — that's server-side).
 *
 * The literate home for a method's contract AND its documentation: beyond the
 * Zod `args`/`returns`, doc/access fields below are plain serializable metadata
 * (not Zod refinements, so `zod-to-json-schema` preserves them) that flow to
 * agents via the capability catalog. The serializer must explicitly emit them.
 */
export interface MethodSchema {
  description?: string;
  args: z.ZodType;
  returns?: z.ZodType;
  /** Whether this wire method belongs in agent-facing capability discovery.
   *  Defaults to true. Set false for implementation transports that remain
   *  callable by typed runtime clients but have a higher-level public API. */
  agentFacing?: boolean;
  /** Enforced caller-kind gate. Overrides the service policy for this method. */
  policy?: ServicePolicy;
  /** Unified access & restrictedness descriptor (caller kinds, conditional
   *  restrictions, sensitivity, side-effects, approval/grant gates). */
  access?: MethodAccessDescriptor;
  /** Worked examples (catalog + JIT teaching). */
  examples?: MethodExample[];
  /** Documented error outcomes. */
  errors?: MethodError[];
  /** Related methods, as qualified names (e.g. "eval.getRun"). */
  seeAlso?: string[];
}

export type ServiceMethodSchemas = Record<string, MethodSchema>;

/**
 * Identity helper that preserves the literal key/schema types of a method
 * table for client derivation while checking the table's shape.
 */
export function defineServiceMethods<const M extends ServiceMethodSchemas>(methods: M): M {
  return methods;
}

/**
 * Relax trailing tuple elements that accept `undefined` into optional
 * parameters. Zod infers `z.tuple([A, B.optional()])` as `[A, B | undefined]`,
 * which would force callers to pass `undefined` explicitly.
 */
export type ArgsOf<T> = T extends readonly [...infer Rest, infer Last]
  ? undefined extends Last
    ? [...ArgsOf<Rest>, Last?]
    : [...Rest, Last]
  : T extends readonly unknown[]
    ? T // open-ended tuple (z.tuple(...).rest(...)) — pass through as-is
    : [];

type MethodResult<D extends MethodSchema> = D["returns"] extends z.ZodType
  ? z.infer<D["returns"]>
  : unknown;

export type MethodFn<D extends MethodSchema> = (
  ...args: ArgsOf<z.infer<D["args"]>>
) => Promise<MethodResult<D>>;

/** The sub-table of methods under a dotted prefix (`"units."` → list, logs, …). */
type SubMethods<M extends ServiceMethodSchemas, H extends string> = {
  [K in keyof M & string as K extends `${H}.${infer Rest}` ? Rest : never]: M[K];
};

/**
 * Typed call surface for a method table: plain names become methods, dotted
 * names become nested groups.
 */
export type TypedServiceClient<M extends ServiceMethodSchemas> = {
  [K in keyof M & string as K extends `${infer Head}.${string}`
    ? Head
    : K]: K extends `${infer Head}.${string}`
    ? TypedServiceClient<SubMethods<M, Head>>
    : MethodFn<M[K]>;
};

/** Transport-agnostic call signature: `(service, method, args) → result`. */
export type ServiceCallFn = (service: string, method: string, args: unknown[]) => Promise<unknown>;

function schemaFailure(
  service: string,
  method: string,
  boundary: "arguments" | "return value",
  error: unknown
): Error {
  const detail = error instanceof Error ? error.message : String(error);
  const failure = new Error(
    `Service "${service}" method "${method}" ${boundary} failed schema validation: ${detail}`
  ) as Error & { cause?: unknown };
  // ErrorOptions is not declared by every consumer tsconfig even though all
  // supported runtimes allow custom Error properties. Preserve the original
  // validator error without requiring an ES2022 Error constructor signature.
  failure.cause = error;
  return failure;
}

/** Validate and dispatch one dynamically selected method from a schema table.
 * Adapters use this when their public method name differs from the wire name. */
export async function callTypedServiceMethod<M extends ServiceMethodSchemas>(
  service: string,
  methods: M,
  call: ServiceCallFn,
  method: keyof M & string,
  args: unknown[]
): Promise<unknown> {
  const definition = methods[method];
  if (!definition) throw new Error(`Service "${service}" has no method "${method}"`);
  let parsedArgs: unknown[];
  try {
    const tupleItems = (definition.args as unknown as { _def?: { items?: readonly unknown[] } })
      ._def?.items;
    const paddedArgs = tupleItems
      ? [...args, ...Array(Math.max(0, tupleItems.length - args.length))]
      : args;
    parsedArgs = definition.args.parse(paddedArgs) as unknown[];
    // Zod tuples require their full item count even when the trailing item is
    // optional. Padding is only a validation detail; preserve omission on the
    // transport unless a schema default materialized an actual value.
    while (parsedArgs.length > args.length && parsedArgs[parsedArgs.length - 1] === undefined) {
      parsedArgs.pop();
    }
  } catch (error) {
    throw schemaFailure(service, method, "arguments", error);
  }
  const result = await call(service, method, parsedArgs);
  if (!definition.returns) return result;
  try {
    return definition.returns.parse(result);
  } catch (error) {
    throw schemaFailure(service, method, "return value", error);
  }
}

/**
 * Build the typed client object for a service. The object is constructed
 * eagerly (no Proxy) so it's enumerable and debuggable; each leaf forwards to
 * `call(service, "<full.method.name>", args)`.
 */
export function createTypedServiceClient<M extends ServiceMethodSchemas>(
  service: string,
  methods: M,
  call: ServiceCallFn
): TypedServiceClient<M> {
  const root: Record<string, unknown> = {};
  for (const fullName of Object.keys(methods)) {
    const segments = fullName.split(".");
    let node = root;
    for (const segment of segments.slice(0, -1)) {
      const next = (node[segment] ??= {});
      if (typeof next !== "object" || next === null) {
        throw new Error(
          `Service "${service}" method "${fullName}" collides with non-group method "${segment}"`
        );
      }
      node = next as Record<string, unknown>;
    }
    const leaf = segments[segments.length - 1]!;
    if (node[leaf] !== undefined) {
      throw new Error(`Service "${service}" method "${fullName}" collides with group "${leaf}"`);
    }
    node[leaf] = (...args: unknown[]) =>
      callTypedServiceMethod(service, methods, call, fullName, args);
  }
  return root as TypedServiceClient<M>;
}

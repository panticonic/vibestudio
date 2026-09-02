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
import type {
  HostResidencyPolicy,
  MethodAccessDescriptor,
  MethodTierPolicy,
  ServiceAuthorityPolicy,
} from "./serviceAuthority.js";
import type { AuthorityRequirement, PrincipalKind } from "./authorization.js";
import type { CapabilityPresentation } from "./authorityPresentation.js";

export interface AuthorityResourcePresentation {
  type: string;
  label: string;
  /** For a compound argument identity, the field people recognize as the
   * target. Enforcement still uses every declared field. */
  displayField?: string | number;
}

export type AuthorityResourceDerivation =
  | { kind: "literal"; key: string; presentation?: AuthorityResourcePresentation }
  | {
      kind: "argument";
      index: number;
      path?: readonly (string | number)[];
      prefix?: string;
      transform?: "url-origin" | "external-url-scope";
      presentation?: AuthorityResourcePresentation;
    }
  | {
      /** Build one stable identity from the scalar fields which jointly name
       * a target, rather than granting on only one convenient field. */
      kind: "argument-fields";
      index: number;
      fields: readonly (string | number)[];
      prefix?: string;
      separator?: string;
      presentation?: AuthorityResourcePresentation;
    };

declare const fixedPreparedAuthorityRequirementBrand: unique symbol;
declare const selectedPreparedAuthorityRequirementBrand: unique symbol;

export type FixedPreparedAuthorityRequirement = AuthorityRequirement & {
  readonly [fixedPreparedAuthorityRequirementBrand]: true;
};

/**
 * Use only when host state determines the actual principals or relationship
 * constraints. The authority preparer must then return a complete
 * `requirement`, including at least one capability leaf. If only the
 * resource/presentation varies, declare a fixed prepared requirement instead.
 */
export interface SelectedPreparedAuthorityRequirement {
  kind: "selected";
  principals: readonly PrincipalKind[];
  readonly [selectedPreparedAuthorityRequirementBrand]: true;
}

export type PreparedAuthorityRequirement =
  | FixedPreparedAuthorityRequirement
  | SelectedPreparedAuthorityRequirement;

/** Mark a prepared leaf whose authority is completely declared in the schema. */
export function fixedPreparedAuthorityRequirement(
  requirement: AuthorityRequirement
): FixedPreparedAuthorityRequirement {
  return requirement as FixedPreparedAuthorityRequirement;
}

/**
 * Declare that a preparer must select the complete authority requirement.
 * The corresponding resolver output must be built with
 * `selectedPreparedAuthoritySelection`, which validates its capability leaves.
 */
export function selectedPreparedAuthorityRequirement(
  principals: readonly PrincipalKind[]
): SelectedPreparedAuthorityRequirement {
  if (principals.length === 0) {
    throw new Error("Selected prepared authority must admit at least one principal family");
  }
  return {
    kind: "selected",
    principals: [...new Set(principals)],
  } as unknown as SelectedPreparedAuthorityRequirement;
}

export type PreparedAuthoritySelector =
  | { capability: string; capabilityPrefix?: never }
  | { capabilityPrefix: string; capability?: never };

export function preparedAuthoritySelectorKey(selector: PreparedAuthoritySelector): string {
  const capability = typeof selector.capability === "string" ? selector.capability : undefined;
  const capabilityPrefix =
    typeof selector.capabilityPrefix === "string" ? selector.capabilityPrefix : undefined;
  if ((capability === undefined) === (capabilityPrefix === undefined)) {
    throw new Error("Prepared authority selector must declare exactly one capability or prefix");
  }
  if (capability !== undefined) {
    if (capability.length === 0) {
      throw new Error("Prepared authority capability must not be empty");
    }
    return `capability:${capability}`;
  }
  if (!capabilityPrefix || !capabilityPrefix.endsWith(":")) {
    throw new Error("Prepared authority capability prefix must be non-empty and end with ':'");
  }
  return `prefix:${capabilityPrefix}`;
}

export interface MethodAuthorityDescriptor {
  requirement: AuthorityRequirement;
  resource: AuthorityResourceDerivation;
  additional?: readonly {
    capability: string;
    requirement: AuthorityRequirement;
    resource: AuthorityResourceDerivation;
    /** Override the method tier for this independent authority leaf. */
    tier?: "open" | "gated" | "critical";
    when?: { origins: readonly ("code" | "user" | "host" | "session")[] };
  }[];
  prepared?: {
    resolver: string;
    /** Generic context-boundary selection owned by the host authority layer. */
    contextBoundary?: {
      operation:
        | "openPanel"
        | "replacePanel"
        | "reload"
        | "unload"
        | "close"
        | "movePanel"
        | "takeOver"
        | "rebuildPanel"
        | "updatePanelState";
      targetArgument: number;
      targetPath?: readonly (string | number)[];
      requestedContextPath?: readonly (string | number)[];
      requestedContextLookup?: {
        method: string;
        arguments: readonly {
          argument: number;
          path?: readonly (string | number)[];
        }[];
        resultPath: readonly (string | number)[];
      };
    };
    leaves: readonly (PreparedAuthoritySelector & {
      requirement: PreparedAuthorityRequirement;
      /** Dynamic leaves may be stricter than the discovery method that selects them. */
      tier?: "open" | "gated" | "critical" | { selectedFrom: readonly ("gated" | "critical")[] };
    })[];
  };
}

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
  /**
   * Stable manifest-facing effect for a promptable method outside the static
   * host census. Colocate it with `tier`; transport method names are not
   * user authority. Static host methods may use the reviewed host mapping.
   */
  capability?: string;
  /** Reviewed prompt copy and semantic category for this exact host effect. */
  presentation?: CapabilityPresentation;
  /** Direct Durable Object receiver effect when it differs from the ordinary
   * host-capability effect derived from `capability`. */
  directEffect?:
    | { kind: "open" }
    | {
        kind: "userland-capability";
        capability: string;
        resource: { kind: "receiver-object" } | { kind: "opaque-handle"; argument: number };
      }
    | {
        kind: "host-capability";
        capability: string;
        resource: { kind: "receiver-object" };
      };
  /** Whether this wire method belongs in agent-facing capability discovery.
   *  Defaults to true. Set false for implementation transports that remain
   *  callable by typed runtime clients but have a higher-level public API. */
  agentFacing?: boolean;
  /**
   * Additional host-attested execution identity required before a direct
   * receiver invocation is dispatched. This is an authenticated runtime fact,
   * never a caller-provided flag or a substitute for method authority.
   */
  execution?: { harness: "attested-system-test" };
  /** Complete compositional authority contract for this method. */
  authority?: ServiceAuthorityPolicy | MethodAuthorityDescriptor;
  /**
   * Colocated reviewed tier. Required for services outside the static host
   * census and preferred for dynamically discovered/userland services.
   */
  tier?: MethodTierPolicy & Partial<HostResidencyPolicy>;
  /** Unified access & restrictedness descriptor (caller kinds, conditional
   *  restrictions, sensitivity, side-effects, approval/grant gates). */
  access?: MethodAccessDescriptor;
  /**
   * Author-facing parameter names, positionally matching the args tuple. A
   * Zod tuple does not retain source parameter names, so this is the literate
   * home for them: help()/docs render calls with these names and argument
   * validation errors use them to name the failing parameter. Length must
   * equal the maximum tuple arity (enforced by serialization tests); where
   * absent, projections fall back to `input`/`arg0` naming.
   */
  argumentNames?: string[];
  /** Worked examples (catalog + JIT teaching). */
  examples?: MethodExample[];
  /** Documented error outcomes. */
  errors?: MethodError[];
  /** Related methods, as qualified names (e.g. "eval.get"). */
  seeAlso?: string[];
  /** Static call-time metadata for RPCs whose completion depends on an external lifecycle. */
  progressSemantics?: {
    kind: "external-wait";
    operation: string;
    resource: { arg: number; kind: string };
  };
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
 * Define a schema-backed Durable Object receiver. An open method is an open
 * receiver effect; every non-open method consumes its declared userland
 * capability against the exact receiver object. Handles and host capabilities
 * remain explicit `directEffect` declarations and are never inferred.
 */
export function defineReceiverServiceMethods<const M extends ServiceMethodSchemas>(methods: M): M {
  return Object.fromEntries(
    Object.entries(methods).map(([name, method]) => {
      if (method.directEffect) return [name, method];
      if (method.tier?.tier === "open") {
        return [name, { ...method, directEffect: { kind: "open" as const } }];
      }
      if (!method.capability) {
        throw new Error(
          `Non-open receiver method ${name} must declare a capability or an explicit directEffect`
        );
      }
      return [
        name,
        {
          ...method,
          directEffect: {
            kind: "userland-capability" as const,
            capability: method.capability,
            resource: { kind: "receiver-object" as const },
          },
        },
      ];
    })
  ) as M;
}

/**
 * The tuple options of a method args schema: a plain `z.tuple` is one option,
 * a union of tuples (call overloads) is several. Returns null when the schema
 * has no tuple shape at all — positional reasoning does not apply there.
 */
export function argsTupleOptions(schema: z.ZodType): z.ZodTuple[] | null {
  // Compared as the literal strings the enum members hold (`ZodTuple`,
  // `ZodUnion`): zod is imported type-only here, so naming
  // z.ZodFirstPartyTypeKind reaches for a value that does not exist at runtime.
  const def = (schema as unknown as { _def?: { typeName?: string; options?: z.ZodType[] } })._def;
  if (def?.typeName === "ZodTuple") return [schema as unknown as z.ZodTuple];
  if (def?.typeName === "ZodUnion") {
    const tuples = (def.options ?? []).filter(
      (option): option is z.ZodTuple =>
        (option as unknown as { _def?: { typeName?: string } })._def?.typeName === "ZodTuple"
    );
    return tuples.length > 0 ? tuples : null;
  }
  return null;
}

/**
 * Maximum positional arity of a method args schema (the longest tuple option),
 * or null for non-tuple schemas. `argumentNames` must have exactly this length.
 */
export function maxArgsArity(schema: z.ZodType): number | null {
  const options = argsTupleOptions(schema);
  if (!options) return null;
  return Math.max(...options.map((tuple) => tuple._def.items.length));
}

/**
 * Whether the schema PROVES that the tuple position may be omitted: true only
 * for a plain tuple whose element at `index` is optional (or beyond a shorter
 * overload). Union overloads with conflicting shapes return false — callers
 * must not guess an omission hint there.
 */
export function argsPositionProvablyOptional(schema: z.ZodType, index: number): boolean {
  const options = argsTupleOptions(schema);
  if (!options) return false;
  return options.every((tuple) => {
    const items = tuple._def.items as z.ZodType[];
    if (index >= items.length) return true;
    return items[index]!.isOptional();
  });
}

/** One argument-validation issue, with the original machine path preserved and
 *  the author-facing parameter name added when the method declares one. */
export interface InvalidArgumentIssue {
  code: string;
  /** Original Zod path: leading tuple index, then nested segments. */
  path: (string | number)[];
  message: string;
  expected?: string;
  received?: string;
  /** Author-facing name of the failing method parameter, when declared. */
  parameter?: string;
  /** `path` with the tuple index replaced by the parameter name. */
  parameterPath?: (string | number)[];
}

/**
 * The ONE argument-validation formatter (server, Electron, DO receiver, and
 * eval all route here): a concise human summary plus the structured issue
 * list that crosses the wire as errorData. When the method declares
 * `argumentNames`, the leading tuple index is translated into the parameter
 * name; the numeric machine path is always retained. An omission hint is added
 * only when the tuple position is provably optional in the schema.
 */
export function describeArgsValidationError(
  error: z.ZodError,
  methodDef?: Pick<MethodSchema, "args" | "argumentNames">
): { summary: string; issues: InvalidArgumentIssue[] } {
  const names = methodDef?.argumentNames;
  const issues = error.issues.map((issue): InvalidArgumentIssue => {
    const [head, ...rest] = issue.path;
    const parameter = typeof head === "number" ? names?.[head] : undefined;
    const expected = "expected" in issue ? String(issue.expected) : undefined;
    const received = "received" in issue ? String(issue.received) : undefined;
    return {
      code: issue.code,
      path: [...issue.path],
      message: issue.message,
      ...(expected !== undefined ? { expected } : {}),
      ...(received !== undefined ? { received } : {}),
      ...(parameter !== undefined
        ? { parameter, parameterPath: [parameter, ...rest] }
        : {}),
    };
  });
  const summaries = issues.map((issue) => {
    const [head, ...rest] = issue.path;
    const where =
      typeof head === "number"
        ? `[${head}]${rest.length > 0 ? `.${rest.join(".")}` : ""}`
        : issue.path.length > 0
          ? issue.path.join(".")
          : "(args)";
    const named = issue.parameter
      ? ` (parameter \`${issue.parameterPath!.join(".")}\`)`
      : "";
    const detail =
      issue.code === "invalid_type"
        ? `expected ${issue.expected}, received ${issue.received}`
        : issue.message;
    const omissionHint =
      issue.code === "invalid_type" &&
      typeof head === "number" &&
      rest.length === 0 &&
      (issue.received === "null" || issue.received === "undefined") &&
      methodDef !== undefined &&
      argsPositionProvablyOptional(methodDef.args, head)
        ? `; omit the optional ${issue.parameter ? `\`${issue.parameter}\`` : "value"} or pass ${issue.expected}`
        : "";
    return `invalid argument ${where}${named} — ${detail}${omissionHint}`;
  });
  return { summary: summaries.join("; "), issues };
}

/** Structured wire payload for an argument-validation failure. Services own
 *  errorData's schema; every relay preserves it end to end. */
export function invalidArgumentsErrorData(
  service: string,
  method: string,
  issues: InvalidArgumentIssue[]
): Record<string, unknown> {
  return { code: "invalid-arguments", method: `${service}.${method}`, issues };
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
  error: unknown,
  expectedCall?: string
): Error {
  const detail = error instanceof Error ? error.message : String(error);
  const failure = new Error(
    `Service "${service}" method "${method}" ${boundary} failed schema validation${
      expectedCall ? `. Expected call shape: ${expectedCall}` : ""
    }: ${detail}`
  ) as Error & { cause?: unknown };
  // ErrorOptions is not declared by every consumer tsconfig even though all
  // supported runtimes allow custom Error properties. Preserve the original
  // validator error without requiring an ES2022 Error constructor signature.
  failure.cause = error;
  return failure;
}

function expectedCallShape(service: string, method: string, definition: MethodSchema): string {
  const tupleItems = (
    definition.args as unknown as {
      _def?: { items?: readonly z.ZodTypeAny[] };
    }
  )._def?.items;
  if (!tupleItems) return `${service}.${method}(...)`;
  const args = tupleItems.map((schema, index) => {
    const shape = (schema as unknown as { shape?: Record<string, unknown> }).shape;
    if (!shape) return `arg${index + 1}`;
    const fields = Object.entries(shape).map(([name, field]) => {
      const optional =
        typeof field === "object" &&
        field !== null &&
        "isOptional" in field &&
        typeof field.isOptional === "function" &&
        field.isOptional();
      return `${name}${optional ? "?" : ""}`;
    });
    return `{ ${fields.join(", ")} }`;
  });
  return `${service}.${method}(${args.join(", ")})`;
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
    throw schemaFailure(
      service,
      method,
      "arguments",
      error,
      expectedCallShape(service, method, definition)
    );
  }
  const result = await call(service, method, parsedArgs);
  if (!definition.returns) return result;
  try {
    // JSON success envelopes represent logical `undefined` as `null`. Convert
    // only when the declared schema accepts undefined and rejects null, so
    // nullable domain results remain untouched.
    const normalizedResult =
      result === null &&
      !definition.returns.safeParse(null).success &&
      definition.returns.safeParse(undefined).success
        ? undefined
        : result;
    return definition.returns.parse(normalizedResult);
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

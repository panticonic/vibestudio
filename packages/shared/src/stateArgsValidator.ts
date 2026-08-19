import type { JSONSchema7, JSONSchema7Definition, JSONSchema7TypeName } from "json-schema";
import type { StateArgsSchema, StateArgsValue, StateArgsValidation } from "./stateArgs.js";
import { normalizeStateArgs } from "./stateArgsSerialization.js";

/**
 * Interpreted draft-07 validator for panel state args.
 *
 * State args are validated wherever a panel is opened or updated: in the host,
 * in a panel webview, and in the workerd eval kernel. The eval kernel blocks
 * `new Function` (guest code goes through its own compiler seam), so a
 * code-generating validator such as Ajv cannot run there. This interpreter
 * walks the schema directly and keeps the behavior the rest of the system
 * relies on: defaults are applied (`useDefaults`), primitive types are coerced
 * (`coerceTypes`), and messages read `<instancePath> <message>`.
 *
 * Keywords outside the supported subset are rejected loudly (a thrown error,
 * as a compile error would be) rather than silently ignored, so a manifest can
 * never appear validated when it is not.
 */

const SUPPORTED_KEYWORDS = new Set([
  "$schema",
  "$id",
  "$comment",
  "title",
  "description",
  "default",
  "examples",
  "type",
  "enum",
  "const",
  "properties",
  "required",
  "additionalProperties",
  "minProperties",
  "maxProperties",
  "items",
  "additionalItems",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "anyOf",
  "oneOf",
  "allOf",
  "not",
  "if",
  "then",
  "else",
]);

const TYPE_NAMES: ReadonlySet<string> = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "object",
  "array",
  "null",
]);

interface ValidationError {
  instancePath: string;
  message: string;
}

class SchemaError extends Error {
  constructor(message: string) {
    super(`stateArgs schema: ${message}`);
    this.name = "StateArgsSchemaError";
  }
}

function assertSupported(schema: JSONSchema7Definition, schemaPath: string): void {
  if (typeof schema === "boolean") return;
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new SchemaError(`${schemaPath || "#"} must be an object or boolean`);
  }
  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED_KEYWORDS.has(keyword)) {
      throw new SchemaError(`unsupported keyword "${keyword}" at ${schemaPath || "#"}`);
    }
  }
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    for (const type of types) {
      if (!TYPE_NAMES.has(type))
        throw new SchemaError(`unknown type "${type}" at ${schemaPath || "#"}`);
    }
  }
  if (schema.properties) {
    for (const [name, sub] of Object.entries(schema.properties)) {
      assertSupported(sub, `${schemaPath}/properties/${name}`);
    }
  }
  if (typeof schema.additionalProperties === "object") {
    assertSupported(schema.additionalProperties, `${schemaPath}/additionalProperties`);
  }
  if (schema.items !== undefined) {
    if (Array.isArray(schema.items)) {
      schema.items.forEach((sub, index) => assertSupported(sub, `${schemaPath}/items/${index}`));
    } else {
      assertSupported(schema.items, `${schemaPath}/items`);
    }
  }
  if (typeof schema.additionalItems === "object") {
    assertSupported(schema.additionalItems, `${schemaPath}/additionalItems`);
  }
  for (const keyword of ["anyOf", "oneOf", "allOf"] as const) {
    const list = schema[keyword];
    if (list)
      list.forEach((sub, index) => assertSupported(sub, `${schemaPath}/${keyword}/${index}`));
  }
  for (const keyword of ["not", "if", "then", "else"] as const) {
    const sub = schema[keyword];
    if (sub !== undefined) assertSupported(sub, `${schemaPath}/${keyword}`);
  }
}

const checkedSchemas = new WeakSet<object>();

function typeOf(value: unknown): JSONSchema7TypeName {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return "object";
  }
}

function matchesType(value: unknown, type: JSONSchema7TypeName): boolean {
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeOf(value) === type;
}

/** Ajv `coerceTypes: true` rules for scalars. Returns `undefined` when no coercion applies. */
function coerce(value: unknown, type: JSONSchema7TypeName): { value: unknown } | undefined {
  switch (type) {
    case "string":
      if (typeof value === "number" || typeof value === "boolean") return { value: String(value) };
      if (value === null) return { value: "" };
      return undefined;
    case "number":
    case "integer": {
      let next: number | undefined;
      if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
        next = Number(value);
      } else if (typeof value === "boolean") {
        next = value ? 1 : 0;
      } else if (value === null) {
        next = 0;
      }
      if (next === undefined) return undefined;
      if (type === "integer" && !Number.isInteger(next)) return undefined;
      return { value: next };
    }
    case "boolean":
      if (value === "true" || value === 1) return { value: true };
      if (value === "false" || value === 0 || value === null) return { value: false };
      return undefined;
    case "null":
      if (value === "" || value === 0 || value === false) return { value: null };
      return undefined;
    default:
      return undefined;
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null) return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, b[index]));
  }
  if (typeof a === "object") {
    if (Array.isArray(b)) return false;
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    const keys = Object.keys(left);
    if (keys.length !== Object.keys(right).length) return false;
    return keys.every((key) => deepEqual(left[key], right[key]));
  }
  return false;
}

function clone<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/**
 * Validate `value` against `schema`, mutating the parent slot through `assign`
 * when a default or coercion changes it. Returns the list of errors (empty when
 * valid). Collection mirrors Ajv's `allErrors: false` — the first failing
 * keyword of a subschema stops that subschema.
 */
function validateNode(
  schema: JSONSchema7Definition,
  value: unknown,
  instancePath: string,
  assign: ((next: unknown) => void) | null
): ValidationError[] {
  if (schema === true) return [];
  if (schema === false) return [{ instancePath, message: "boolean schema is false" }];
  let current = value;

  // type (with coercion)
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => matchesType(current, type))) {
      let coerced: { value: unknown } | undefined;
      if (assign) {
        for (const type of types) {
          coerced = coerce(current, type);
          if (coerced) break;
        }
      }
      if (!coerced) {
        return [{ instancePath, message: `must be ${types.join(",")}` }];
      }
      current = coerced.value;
      assign?.(current);
    }
  }
  if (schema.enum !== undefined && !schema.enum.some((allowed) => deepEqual(allowed, current))) {
    return [{ instancePath, message: "must be equal to one of the allowed values" }];
  }
  if (schema.const !== undefined && !deepEqual(schema.const, current)) {
    return [{ instancePath, message: "must be equal to constant" }];
  }

  if (typeof current === "number") {
    if (schema.minimum !== undefined && current < schema.minimum)
      return [{ instancePath, message: `must be >= ${schema.minimum}` }];
    if (schema.maximum !== undefined && current > schema.maximum)
      return [{ instancePath, message: `must be <= ${schema.maximum}` }];
    if (schema.exclusiveMinimum !== undefined && current <= schema.exclusiveMinimum)
      return [{ instancePath, message: `must be > ${schema.exclusiveMinimum}` }];
    if (schema.exclusiveMaximum !== undefined && current >= schema.exclusiveMaximum)
      return [{ instancePath, message: `must be < ${schema.exclusiveMaximum}` }];
    if (schema.multipleOf !== undefined) {
      const quotient = current / schema.multipleOf;
      if (Math.abs(quotient - Math.round(quotient)) > 1e-9)
        return [{ instancePath, message: `must be multiple of ${schema.multipleOf}` }];
    }
  }
  if (typeof current === "string") {
    const length = [...current].length;
    if (schema.minLength !== undefined && length < schema.minLength)
      return [{ instancePath, message: `must NOT have fewer than ${schema.minLength} characters` }];
    if (schema.maxLength !== undefined && length > schema.maxLength)
      return [{ instancePath, message: `must NOT have more than ${schema.maxLength} characters` }];
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(current))
      return [{ instancePath, message: `must match pattern "${schema.pattern}"` }];
  }
  if (Array.isArray(current)) {
    if (schema.minItems !== undefined && current.length < schema.minItems)
      return [{ instancePath, message: `must NOT have fewer than ${schema.minItems} items` }];
    if (schema.maxItems !== undefined && current.length > schema.maxItems)
      return [{ instancePath, message: `must NOT have more than ${schema.maxItems} items` }];
    if (schema.uniqueItems) {
      for (let i = 0; i < current.length; i++) {
        for (let j = i + 1; j < current.length; j++) {
          if (deepEqual(current[i], current[j]))
            return [
              {
                instancePath,
                message: `must NOT have duplicate items (items ## ${j} and ${i} are identical)`,
              },
            ];
        }
      }
    }
    if (schema.items !== undefined) {
      const list = current;
      if (Array.isArray(schema.items)) {
        const tuple = schema.items;
        for (let index = 0; index < tuple.length; index++) {
          const itemSchema = tuple[index]!;
          if (
            list[index] === undefined &&
            typeof itemSchema === "object" &&
            itemSchema.default !== undefined &&
            index < list.length
          ) {
            list[index] = clone(itemSchema.default);
          }
          if (index >= list.length) continue;
          const errors = validateNode(
            itemSchema,
            list[index],
            `${instancePath}/${index}`,
            (next) => {
              list[index] = next;
            }
          );
          if (errors.length) return errors;
        }
        if (schema.additionalItems === false && list.length > tuple.length)
          return [{ instancePath, message: `must NOT have more than ${tuple.length} items` }];
        if (typeof schema.additionalItems === "object") {
          for (let index = tuple.length; index < list.length; index++) {
            const errors = validateNode(
              schema.additionalItems,
              list[index],
              `${instancePath}/${index}`,
              (next) => {
                list[index] = next;
              }
            );
            if (errors.length) return errors;
          }
        }
      } else {
        const itemSchema = schema.items;
        for (let index = 0; index < list.length; index++) {
          const errors = validateNode(
            itemSchema,
            list[index],
            `${instancePath}/${index}`,
            (next) => {
              list[index] = next;
            }
          );
          if (errors.length) return errors;
        }
      }
    }
  }
  if (current !== null && typeof current === "object" && !Array.isArray(current)) {
    const record = current as Record<string, unknown>;
    // defaults first, as Ajv does, so `required` can be satisfied by a default
    if (schema.properties) {
      for (const [name, sub] of Object.entries(schema.properties)) {
        if (record[name] === undefined && typeof sub === "object" && sub.default !== undefined) {
          record[name] = clone(sub.default);
        }
      }
    }
    if (schema.required) {
      for (const name of schema.required) {
        if (record[name] === undefined)
          return [{ instancePath, message: `must have required property '${name}'` }];
      }
    }
    const keys = Object.keys(record);
    if (schema.minProperties !== undefined && keys.length < schema.minProperties)
      return [
        { instancePath, message: `must NOT have fewer than ${schema.minProperties} properties` },
      ];
    if (schema.maxProperties !== undefined && keys.length > schema.maxProperties)
      return [
        { instancePath, message: `must NOT have more than ${schema.maxProperties} properties` },
      ];
    if (schema.properties) {
      for (const [name, sub] of Object.entries(schema.properties)) {
        if (!(name in record)) continue;
        const errors = validateNode(sub, record[name], `${instancePath}/${name}`, (next) => {
          record[name] = next;
        });
        if (errors.length) return errors;
      }
    }
    if (schema.additionalProperties !== undefined && schema.additionalProperties !== true) {
      const declared = new Set(Object.keys(schema.properties ?? {}));
      for (const name of keys) {
        if (declared.has(name)) continue;
        if (schema.additionalProperties === false)
          return [{ instancePath, message: "must NOT have additional properties" }];
        const errors = validateNode(
          schema.additionalProperties,
          record[name],
          `${instancePath}/${name}`,
          (next) => {
            record[name] = next;
          }
        );
        if (errors.length) return errors;
      }
    }
  }

  // combinators — evaluated against a snapshot so a failing branch never
  // leaves partial coercions/defaults behind
  if (schema.allOf) {
    for (const sub of schema.allOf) {
      const errors = validateNode(sub, current, instancePath, assign);
      if (errors.length) return errors;
    }
  }
  if (schema.anyOf) {
    const passed = schema.anyOf.some(
      (sub) => validateNode(sub, clone(current), instancePath, null).length === 0
    );
    if (!passed) return [{ instancePath, message: "must match a schema in anyOf" }];
  }
  if (schema.oneOf) {
    const passing = schema.oneOf.filter(
      (sub) => validateNode(sub, clone(current), instancePath, null).length === 0
    ).length;
    if (passing !== 1) return [{ instancePath, message: "must match exactly one schema in oneOf" }];
  }
  if (schema.not !== undefined) {
    if (validateNode(schema.not, clone(current), instancePath, null).length === 0)
      return [{ instancePath, message: "must NOT be valid" }];
  }
  if (schema.if !== undefined) {
    const matched = validateNode(schema.if, clone(current), instancePath, null).length === 0;
    const branch = matched ? schema.then : schema.else;
    if (branch !== undefined) {
      const errors = validateNode(branch, current, instancePath, assign);
      if (errors.length)
        return [{ instancePath, message: `must match "${matched ? "then" : "else"}" schema` }];
    }
  }
  return [];
}

/**
 * Validate state args against manifest schema.
 * Returns validated data (with defaults applied and scalars coerced) or errors.
 */
export function validateStateArgs(
  args: unknown,
  schema: StateArgsSchema | undefined
): StateArgsValidation {
  // First, ensure input is JSON-serializable (catches functions, circular refs, etc.)
  const normalized = normalizeStateArgs(args);
  if (!normalized.success) return normalized;
  const data = normalized.data as StateArgsValue;

  // No schema = accept any JSON-serializable value
  if (!schema) {
    return { success: true, data };
  }
  if (!checkedSchemas.has(schema)) {
    assertSupported(schema as JSONSchema7, "");
    checkedSchemas.add(schema);
  }

  let root: unknown = data;
  const errors = validateNode(schema as JSONSchema7, root, "", (next) => {
    root = next;
  });
  if (errors.length === 0) {
    return { success: true, data: root as StateArgsValue };
  }
  return {
    success: false,
    error: errors.map((e) => `${e.instancePath} ${e.message}`).join("; "),
  };
}

/**
 * Render OpenAPI-3-flavoured JSON Schema (what zod-to-json-schema emits for the
 * service method contracts) as TypeScript declaration text with doc comments.
 *
 * The declarations are what a model reads about a service, so they favour
 * legibility over completeness: constraints that do not change the type
 * (lengths, patterns, formats) are dropped, descriptions become doc comments,
 * and anything the schema does not pin down is `unknown`.
 */

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;

export function docComment(text, indent = "") {
  const lines = String(text).trim().replaceAll("*/", "* /").split(/\r?\n/u);
  if (lines.length === 1) return `${indent}/** ${lines[0]} */`;
  return [
    `${indent}/**`,
    ...lines.map((line) => `${indent} * ${line}`.trimEnd()),
    `${indent} */`,
  ].join("\n");
}

function literal(value) {
  return typeof value === "string" ? JSON.stringify(value) : String(value);
}

function withNullable(type, schema) {
  if (schema.nullable !== true) return type;
  return type === "null" ? type : `${type} | null`;
}

/** True when `type` has a `|` or `&` outside every bracket, string, and comment. */
function hasTopLevelOperator(type) {
  let depth = 0;
  for (let i = 0; i < type.length; i++) {
    const char = type[i];
    if (char === '"') {
      i++;
      while (i < type.length && type[i] !== '"') i += type[i] === "\\" ? 2 : 1;
    } else if (char === "/" && type[i + 1] === "*") {
      i = type.indexOf("*/", i + 2) + 1;
      if (i === 0) return false;
    } else if ("{[(<".includes(char)) depth++;
    else if ("}])>".includes(char)) depth--;
    else if ((char === "|" || char === "&") && depth === 0) return true;
  }
  return false;
}

function parenthesize(type) {
  return hasTopLevelOperator(type) ? `(${type})` : type;
}

function joinUnion(types) {
  const unique = [...new Set(types)].filter((type) => type !== "never");
  return unique.length === 0 ? "never" : unique.join(" | ");
}

/** The TypeScript type text for one schema, indented at `indent`. */
export function schemaToType(schema, indent = "") {
  if (schema === true || schema === undefined || schema === null) return "unknown";
  if (schema === false) return "never";
  // zod's `.optional()` inside a tuple is an `anyOf` with an unmatchable arm.
  if (schema.not && Object.keys(schema.not).length === 0) return "never";
  if (Array.isArray(schema.enum)) {
    return withNullable(joinUnion(schema.enum.map(literal)), schema);
  }
  if (schema.const !== undefined) return withNullable(literal(schema.const), schema);
  const variants = schema.anyOf ?? schema.oneOf;
  if (Array.isArray(variants)) {
    const rendered = variants.map((variant) => schemaToType(variant, indent));
    return withNullable(joinUnion(rendered), schema);
  }
  if (Array.isArray(schema.allOf)) {
    const rendered = schema.allOf.map((part) => parenthesize(schemaToType(part, indent)));
    return withNullable(rendered.join(" & "), schema);
  }
  switch (schema.type) {
    case "string":
      return withNullable("string", schema);
    case "number":
    case "integer":
      return withNullable("number", schema);
    case "boolean":
      return withNullable("boolean", schema);
    case "null":
      return "null";
    case "array":
      return withNullable(arrayType(schema, indent), schema);
    case "object":
      return withNullable(objectType(schema, indent), schema);
    default:
      if (schema.properties) return withNullable(objectType(schema, indent), schema);
      return schema.nullable === true ? "unknown" : "unknown";
  }
}

function arrayType(schema, indent) {
  if (Array.isArray(schema.items)) {
    const required = schema.minItems ?? schema.items.length;
    const elements = schema.items.map(
      (item, index) => `${schemaToType(item, indent)}${index >= required ? "?" : ""}`
    );
    return `[${elements.join(", ")}]`;
  }
  const element = parenthesize(schemaToType(schema.items, indent));
  return `${element}[]`;
}

function objectType(schema, indent) {
  const properties = Object.entries(schema.properties ?? {});
  const extra = schema.additionalProperties;
  const index =
    extra && typeof extra === "object"
      ? [`${indent}  [key: string]: ${schemaToType(extra, `${indent}  `)};`]
      : extra === true && properties.length === 0
        ? [`${indent}  [key: string]: unknown;`]
        : [];
  if (properties.length === 0 && index.length === 0) {
    return extra === false ? "{}" : "Record<string, unknown>";
  }
  const required = new Set(schema.required ?? []);
  const members = properties.map(([key, value]) => {
    const name = IDENTIFIER.test(key) ? key : JSON.stringify(key);
    const optional = required.has(key) ? "" : "?";
    const doc =
      value && typeof value === "object" && value.description
        ? `${docComment(value.description, `${indent}  `)}\n`
        : "";
    return `${doc}${indent}  ${name}${optional}: ${schemaToType(value, `${indent}  `)};`;
  });
  return `{\n${[...members, ...index].join("\n")}\n${indent}}`;
}

/** zod's `.optional()` inside a tuple is an `anyOf` with an unmatchable arm. */
function isOptionalItem(item) {
  const variants = item?.anyOf ?? item?.oneOf;
  return (
    Array.isArray(variants) &&
    variants.some((variant) => variant?.not && Object.keys(variant.not).length === 0)
  );
}

/** Argument schemas are tuples, or a union of tuples; pick one arm. */
function argumentTuple(argsSchema, arm) {
  const variants = argsSchema.anyOf ?? argsSchema.oneOf;
  if (Array.isArray(variants)) {
    const picked = variants[arm ?? 0];
    if (!picked) throw new Error(`argument schema has no arm ${arm ?? 0}`);
    return picked;
  }
  return argsSchema;
}

/**
 * One exported function declaration.
 * @param {object} method
 * @param {string} method.name
 * @param {string} [method.description]
 * @param {object} method.argsSchema JSON schema of the argument tuple
 * @param {object} [method.returnsSchema]
 * @param {string[]} [method.params] positional parameter names
 * @param {number} [method.argsArm] which tuple of a union to document
 */
export function renderMethod(method) {
  const tuple = argumentTuple(method.argsSchema, method.argsArm);
  const items = Array.isArray(tuple.items) ? tuple.items : [];
  const required = tuple.minItems ?? items.length;
  const names = method.params ?? [];
  if (names.length !== items.length) {
    throw new Error(
      `${method.name}: ${items.length} argument(s) in the contract, ${names.length} parameter name(s) declared`
    );
  }
  const params = items.map((item, index) => {
    const optional = index >= required || isOptionalItem(item);
    return `${names[index]}${optional ? "?" : ""}: ${schemaToType(item)}`;
  });
  const returns = method.returnsSchema ? schemaToType(method.returnsSchema) : "void";
  const doc = method.description ? `${docComment(method.description)}\n` : "";
  return `${doc}export function ${method.name}(${params.join(", ")}): Promise<${returns}>;`;
}

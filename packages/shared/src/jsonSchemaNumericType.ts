/** Human-readable validation shared by live documentation and compact eval help. */
export function jsonSchemaNumericType(
  type: "integer" | "number",
  schema: Readonly<Record<string, unknown>>,
): string {
  const bounds: string[] = [];
  for (const [key, inclusive, exclusive] of [
    ["minimum", ">=", ">"],
    ["maximum", "<=", "<"],
  ] as const) {
    const exclusion = schema[key === "minimum" ? "exclusiveMinimum" : "exclusiveMaximum"];
    if (typeof schema[key] === "number") {
      bounds.push(`${exclusion === true ? exclusive : inclusive} ${schema[key]}`);
    }
    // JSON Schema uses a numeric exclusive bound; OpenAPI 3 uses a boolean
    // modifying the inclusive bound. Preserve independent numeric constraints.
    if (typeof exclusion === "number") bounds.push(`${exclusive} ${exclusion}`);
  }
  if (typeof schema["multipleOf"] === "number") {
    bounds.push(`multiple of ${schema["multipleOf"]}`);
  }
  return `${type}${bounds.length ? ` (${bounds.join(", ")})` : ""}`;
}

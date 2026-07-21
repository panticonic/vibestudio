import { Kind } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { AgentTool } from "@workspace/pi-core";

/** Prepare legacy argument shapes, then enforce the tool's advertised schema
 * at the durable execution boundary. Model providers may emit malformed tool
 * calls; no local tool may rely on provider-side validation for safety. */
export function prepareAgentToolArguments(tool: AgentTool, raw: unknown): unknown {
  const prepared = tool.prepareArguments ? tool.prepareArguments(raw) : raw;
  if (!isRecord(tool.parameters) || !(Kind in tool.parameters)) return prepared;
  const mismatch = findDiscriminatorMismatch(tool.parameters, prepared);
  if (mismatch) {
    throw new Error(
      `Invalid arguments for tool ${tool.name}: ${mismatch.path}: Expected one of ${mismatch.expected.map((value) => JSON.stringify(value)).join(", ")}; received ${JSON.stringify(mismatch.actual)}`
    );
  }
  const schema = specializeDiscriminatedUnions(tool.parameters, prepared);
  const errors = [...Value.Errors(schema as never, prepared)].slice(0, 3);
  if (errors.length === 0) return prepared;
  const detail = errors.map((error) => `${error.path || "/"}: ${error.message}`).join("; ");
  throw new Error(`Invalid arguments for tool ${tool.name}: ${detail}`);
}

function findDiscriminatorMismatch(
  schema: unknown,
  value: unknown,
  path = ""
): { path: string; expected: unknown[]; actual: unknown } | null {
  if (!isRecord(schema) || !isRecord(value)) return null;
  const alternatives = Array.isArray(schema["anyOf"]) ? schema["anyOf"] : null;
  if (alternatives) {
    const discriminators = new Map<string, unknown[]>();
    for (const candidate of alternatives) {
      if (!isRecord(candidate) || !isRecord(candidate["properties"])) continue;
      for (const [key, property] of Object.entries(candidate["properties"])) {
        if (!isRecord(property) || !Object.hasOwn(property, "const")) continue;
        const values = discriminators.get(key) ?? [];
        if (!values.includes(property["const"])) values.push(property["const"]);
        discriminators.set(key, values);
      }
    }
    for (const [key, expected] of discriminators) {
      if (expected.length < 2 || !Object.hasOwn(value, key) || expected.includes(value[key]))
        continue;
      return { path: `${path}/${key}`, expected, actual: value[key] };
    }
    const matching = alternatives.filter((candidate) => branchMatches(candidate, value));
    if (matching.length === 1) return findDiscriminatorMismatch(matching[0], value, path);
  }
  const properties = isRecord(schema["properties"]) ? schema["properties"] : null;
  if (!properties) return null;
  for (const [key, child] of Object.entries(properties)) {
    const mismatch = findDiscriminatorMismatch(child, value[key], `${path}/${key}`);
    if (mismatch) return mismatch;
  }
  return null;
}

/** Select the schema branch named by literal discriminator fields before
 * formatting validation failures. TypeBox correctly rejects a bad union, but
 * its exhaustive branch errors otherwise lead with an unrelated first branch
 * (for example `status` when an `integrate` request is missing evidence). */
function specializeDiscriminatedUnions(schema: unknown, value: unknown): unknown {
  if (!isRecord(schema)) return schema;
  const alternatives = Array.isArray(schema["anyOf"]) ? schema["anyOf"] : null;
  if (alternatives && isRecord(value)) {
    const matching = alternatives.filter((candidate) => branchMatches(candidate, value));
    if (matching.length === 1) return specializeDiscriminatedUnions(matching[0], value);
  }
  const properties = isRecord(schema["properties"]) ? schema["properties"] : null;
  if (!properties || !isRecord(value)) return schema;
  return {
    ...schema,
    properties: Object.fromEntries(
      Object.entries(properties).map(([key, child]) => [
        key,
        specializeDiscriminatedUnions(child, value[key]),
      ])
    ),
  };
}

function branchMatches(candidate: unknown, value: Record<string, unknown>): boolean {
  if (!isRecord(candidate) || !isRecord(candidate["properties"])) return false;
  const discriminators = Object.entries(candidate["properties"]).filter(
    ([, property]) => isRecord(property) && Object.hasOwn(property, "const")
  );
  return (
    discriminators.length > 0 &&
    discriminators.every(
      ([key, property]) => isRecord(property) && value[key] === property["const"]
    )
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

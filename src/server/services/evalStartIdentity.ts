import { createHash } from "node:crypto";
import type { EvalStartInput } from "@vibestudio/service-schemas/eval";

/** Digest of the complete normalized public start intent. Object key order and
 * omitted optional fields cannot create distinct idempotency identities. */
export function evalStartIntentDigest(input: EvalStartInput): string {
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
}

function canonicalJson(value: unknown): string {
  const normalize = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (!entry || typeof entry !== "object") return entry;
    return Object.fromEntries(
      Object.entries(entry as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, normalize(child)])
    );
  };
  return JSON.stringify(normalize(value));
}

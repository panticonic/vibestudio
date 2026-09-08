import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

/** Every live host transport contributes to one schema-owned vocabulary. */
export function loadHostServiceAuthorityMatrices(root) {
  return [
    "src/server/services/__serviceAuthorityMatrix.golden.json",
    "src/main/services/__serviceAuthorityMatrix.golden.json",
    "src/server/__hubServiceAuthorityMatrix.golden.json",
  ].map((relative) => JSON.parse(fs.readFileSync(path.join(root, relative), "utf8")));
}

/** Resolve transport-local inheritance before merging shared method contracts. */
export function mergeHostServiceAuthorityMatrices(matrices) {
  const result = {};
  for (const matrix of matrices) {
    for (const [service, entry] of Object.entries(matrix)) {
      const merged = result[service] ?? { service: { principals: [] }, methods: {} };
      merged.service.principals = [
        ...new Set([...merged.service.principals, ...(entry.service?.principals ?? [])]),
      ].sort();
      for (const [method, declaration] of Object.entries(entry.methods)) {
        const resolved = {
          ...declaration,
          authority: declaration.authority?.inherits ? entry.service : declaration.authority,
        };
        if (merged.methods[method] && !isDeepStrictEqual(merged.methods[method], resolved)) {
          throw new Error(`Host method ${service}.${method} has conflicting transport contracts`);
        }
        merged.methods[method] = resolved;
      }
      result[service] = merged;
    }
  }
  return result;
}

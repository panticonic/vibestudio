import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { portableExports } from "./runtimeSurface.portable.js";

describe("runtime surface schemaRef parity", () => {
  it("every schemaRef resolves to a serviceSchemas/<ref>.ts file", () => {
    const schemaDir = join(dirname(fileURLToPath(import.meta.url)), "serviceSchemas");
    const files = new Set(readdirSync(schemaDir));
    const dangling: string[] = [];
    for (const [name, entry] of Object.entries(portableExports)) {
      const ref = entry.schemaRef;
      if (ref && !files.has(`${ref}.ts`)) dangling.push(`${name} → ${ref}`);
    }
    expect(
      dangling,
      `runtime-surface schemaRef must name a serviceSchemas file: ${dangling.join(", ")}`
    ).toEqual([]);
  });
});

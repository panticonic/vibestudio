import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createDirectHubControlService } from "./hubServer.js";

const goldenPath = fileURLToPath(
  new URL("./__hubServiceAuthorityMatrix.golden.json", import.meta.url)
);

describe("hub service authority matrix", () => {
  it("records the live hub transport separately from workspace-scoped services", () => {
    // Construction is pure; authenticated hub state is read only by handlers.
    // The hub and each workspace expose different subsets under hubControl.
    const definition = createDirectHubControlService(
      {} as Parameters<typeof createDirectHubControlService>[0]
    );
    const matrix = {
      [definition.name]: {
        service: definition.authority,
        methods: Object.fromEntries(
          Object.entries(definition.methods)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([name, schema]) => [
              name,
              {
                authority: schema.authority ?? { inherits: true },
                access: schema.access ?? null,
                tier: schema.tier ?? null,
                capability: schema.capability ?? null,
                presentation: schema.presentation ?? null,
              },
            ])
        ),
      },
    };
    if (process.env["UPDATE_GOLDEN"]) {
      writeFileSync(goldenPath, `${JSON.stringify(matrix, null, 2)}\n`);
    }
    expect(matrix).toEqual(JSON.parse(readFileSync(goldenPath, "utf8")));
    expect(matrix[definition.name]?.methods).toHaveProperty("workspaceCreationReceipt");
    expect(matrix[definition.name]?.methods).toHaveProperty("updateProfile");
  });
});

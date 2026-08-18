import { describe, expect, it } from "vitest";
import { lowerLibraryModule } from "./libraryLoweringWorker.js";

describe("library lowering worker", () => {
  it("preserves CommonJS lowering and routes dynamic imports through the eval linker", () => {
    const lowered = lowerLibraryModule(
      'export const answer = 42; export async function load(name) { return import(name); }'
    );

    expect(lowered).toContain("exports.answer");
    expect(lowered).toContain("__vibestudioImport(name)");
    expect(lowered).not.toContain("import(name)");
  });
});

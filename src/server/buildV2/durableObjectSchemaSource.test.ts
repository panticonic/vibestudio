import { describe, expect, it } from "vitest";
import { migrationDefinitionSourceDigest } from "./durableObjectSchemaSource.js";

const moduleOf = (source: string) => [
  { moduleId: "workers/board/index.ts", format: "ts" as const, source },
];

describe("migrationDefinitionSourceDigest", () => {
  const definition = `{
    version: 2,
    name: "add-archive",
    validateSource: (sql) => sql.exec("SELECT 1"),
    migrate: (sql) => sql.exec("ALTER TABLE cards ADD archived INTEGER")
  }`;

  it("hashes only the exact matching pre-bundle migration definition", () => {
    const first = migrationDefinitionSourceDigest(
      moduleOf(`export class BoardDO { schemaMigrations() { return [${definition}]; } }`),
      { className: "BoardDO", version: 2, name: "add-archive" }
    );
    const unrelated = migrationDefinitionSourceDigest(
      moduleOf(
        `const unrelated = 42;\nexport class BoardDO { schemaMigrations() { return [${definition}]; } }`
      ),
      { className: "BoardDO", version: 2, name: "add-archive" }
    );
    expect(unrelated).toBe(first);
  });

  it("changes when migration implementation source changes", () => {
    const first = migrationDefinitionSourceDigest(
      moduleOf(`class BoardDO { schemaMigrations() { return [${definition}]; } }`),
      {
        className: "BoardDO",
        version: 2,
        name: "add-archive",
      }
    );
    const edited = migrationDefinitionSourceDigest(
      moduleOf(
        `class BoardDO { schemaMigrations() { return [${definition.replace(
          "ADD archived INTEGER",
          "ADD archived INTEGER NOT NULL DEFAULT 0"
        )}]; } }`
      ),
      { className: "BoardDO", version: 2, name: "add-archive" }
    );
    expect(edited).not.toBe(first);
  });

  it("fails closed for indirect or ambiguous definitions", () => {
    expect(() =>
      migrationDefinitionSourceDigest(
        moduleOf(`const version = 2; const migration = { ...base, version, name: "add-archive" };`),
        { className: "BoardDO", version: 2, name: "add-archive" }
      )
    ).toThrow(/no literal definition was found/u);
    expect(() =>
      migrationDefinitionSourceDigest(
        moduleOf(`class BoardDO { schemaMigrations() { return [${definition}, ${definition}]; } }`),
        {
          className: "BoardDO",
          version: 2,
          name: "add-archive",
        }
      )
    ).toThrow(/ambiguous/u);
  });
});

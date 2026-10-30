import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { zodToJsonSchema } from "zod-to-json-schema";
import { TypeCheckService } from "@vibestudio/typecheck";
import { systemTestRunSummarySchema } from "../packages/service-schemas/src/systemTestRunner";
import { exactUserlandRoot } from "./exactUserlandRoot";
import { renderMethod, schemaToType } from "../scripts/lib/json-schema-declarations.mjs";
import {
  generate,
  renderServiceDeclarations,
} from "../scripts/generate-natlang-service-declarations.mjs";

describe("natlang service declarations", () => {
  it("are generated from the service contracts and committed fresh", async () => {
    // Fails with the command to run when any contract changed.
    await expect(generate({ checkOnly: true })).resolves.toContain("generatedServiceDeclarations");
  });

  it("compile as ambient namespaces and give a program typed results", async () => {
    const declarations = await renderServiceDeclarations(exactUserlandRoot);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "natlang-declarations-"));
    const service = new TypeCheckService({
      panelPath: root,
      workspaceContext: null,
      disableTsconfigDiscovery: true,
      skipSuggestions: true,
    });
    try {
      const ambient = path.join(root, "services.d.ts");
      const probe = path.join(root, "probe.ts");
      service.updateFile(
        ambient,
        Object.entries(declarations)
          .map(([name, body]) => `declare namespace ${name} {\n${body}\n}`)
          .join("\n\n")
      );
      service.updateFile(
        probe,
        [
          "export async function probe() {",
          '  const found = await web.search({ queries: ["a"] });',
          "  const url: string = found.results[0]!.sources[0]!.url;",
          '  const page = await web.fetch({ url, session: "public" });',
          "  const next: number = (await web.read({ digest: page.digest })).nextOffset;",
          '  const recalled = await memory.recall({ query: "x", kinds: ["file"] });',
          "  const who: string = recalled.results[0]!.where;",
          "  const rows = await addressees.list();",
          "  const ref: string = rows[0]!.ref;",
          "  const tail = await serverLog.tail(10);",
          "  const boot: string = tail.serverBootId;",
          "  const state = await vcs.status({});",
          "  const clean: boolean = state.clean;",
          "  const models = await localModels.listModels();",
          '  const ready: boolean = models.some((m) => m.state === "ready");',
          '  const packet = await systemTests.inspect("do:runner", "run-1");',
          "  return [next, who, ref, boot, clean, ready, packet];",
          "}",
        ].join("\n")
      );
      const diagnostics = service
        .check()
        .diagnostics.map((d) => `${path.basename(d.file ?? "")}: ${d.message}`);
      expect(diagnostics).toEqual([]);
    } finally {
      service.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("describes every field the system-test run summary carries", async () => {
    const { systemTestInspectionSchema } = await import(
      path.join(exactUserlandRoot, "packages/natlang-services/src/contracts.ts")
    );
    for (const key of Object.keys(systemTestRunSummarySchema.shape)) {
      expect(Object.keys(systemTestInspectionSchema.shape), key).toContain(key);
    }
  });
});

describe("json schema declaration renderer", () => {
  it("renders optionality, nullability, unions, arrays of unions, and doc comments", () => {
    const type = schemaToType({
      type: "object",
      properties: {
        a: { type: "string", description: "The a." },
        b: { type: "integer", nullable: true },
        c: { type: "array", items: { anyOf: [{ type: "string" }, { type: "number" }] } },
        d: { type: "string", enum: ["x", "y"] },
        "e-f": { type: "boolean" },
      },
      required: ["a"],
      additionalProperties: false,
    });
    expect(type).toBe(
      [
        "{",
        "  /** The a. */",
        "  a: string;",
        "  b?: number | null;",
        "  c?: (string | number)[];",
        '  d?: "x" | "y";',
        '  "e-f"?: boolean;',
        "}",
      ].join("\n")
    );
  });

  it("makes tuple arguments positional, optional where zod made them optional, and fills bound fields", () => {
    const args = {
      type: "array",
      minItems: 1,
      items: [
        {
          type: "object",
          properties: { contextId: { type: "string" }, name: { type: "string" } },
          required: ["contextId", "name"],
        },
        { anyOf: [{ not: {} }, { type: "number" }] },
      ],
    };
    const text = renderMethod({
      name: "go",
      description: "Go.",
      argsSchema: args,
      returnsSchema: { type: "string" },
      params: ["input", "limit"],
      bound: ["contextId"],
    });
    expect(text).toBe(
      [
        "/** Go. */",
        "export function go(input: {",
        "  contextId?: string;",
        "  name: string;",
        "}, limit?: number): Promise<string>;",
      ].join("\n")
    );
    expect(() => renderMethod({ name: "go", argsSchema: args, params: ["only"] })).toThrow(
      "2 argument(s) in the contract, 1 parameter name(s) declared"
    );
  });

  it("renders a zod contract end to end", () => {
    const { z } = require("zod") as typeof import("zod");
    const schema = zodToJsonSchema(
      z.tuple([z.object({ q: z.string().describe("Query.") }).strict()]),
      {
        target: "openApi3",
        $refStrategy: "none",
      }
    );
    expect(renderMethod({ name: "find", argsSchema: schema, params: ["input"] })).toBe(
      "export function find(input: {\n  /** Query. */\n  q: string;\n}): Promise<void>;"
    );
  });
});

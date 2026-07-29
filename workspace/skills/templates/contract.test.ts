import * as fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("templates skill public contract", () => {
  it("documents separate exact trust/provider suggestion decisions", () => {
    const root = new URL(".", import.meta.url);
    const contract = JSON.parse(fs.readFileSync(new URL("public-contract.json", root), "utf8")) as {
      methods: Record<string, { arguments: string[] }>;
      types: Record<string, string>;
    };
    const skill = fs.readFileSync(new URL("SKILL.md", root), "utf8");
    expect(contract.methods["decideSuggestion"]?.arguments.join(" ")).toContain("accept|decline");
    expect(contract.methods["resume"]?.arguments.join(" ")).toContain("operationId");
    expect(contract.methods["resume"]?.arguments.join(" ")).not.toContain("commandId");
    expect(contract.methods["cancel"]?.arguments.join(" ")).toContain("operationId");
    expect(contract.methods["inspectAuthoring"]?.arguments.join(" ")).toContain("parts");
    expect(contract.methods["publishAuthoring"]?.arguments.join(" ")).toContain("plan");
    expect(contract.types["TemplateInspection"]).toContain("section, value");
    expect(contract.types["TemplateStatusRow"]).not.toContain("contribution");
    expect(skill).toContain("Never fold");
    expect(skill).toContain("a suggestion into template installation approval.");
  });
});

import * as fs from "node:fs";
import { describe, expect, it } from "vitest";

describe("templates skill public contract", () => {
  it("documents separate exact trust/provider suggestion decisions", () => {
    const root = new URL(".", import.meta.url);
    const contract = JSON.parse(fs.readFileSync(new URL("public-contract.json", root), "utf8")) as {
      methods: Record<string, { arguments: string[] }>;
      types: Record<string, string>;
      invariants: string[];
    };
    const skill = fs.readFileSync(new URL("SKILL.md", root), "utf8");
    const prose = skill.replace(/\s+/g, " ");
    const invariants = contract.invariants.join(" ");
    expect(contract.methods["decideSuggestion"]?.arguments.join(" ")).toContain("accept|decline");
    expect(contract.methods["resume"]?.arguments.join(" ")).toContain("operationId");
    expect(contract.methods["resume"]?.arguments.join(" ")).not.toContain("commandId");
    expect(contract.methods["cancel"]?.arguments.join(" ")).toContain("operationId");
    expect(contract.methods["adopt"]?.arguments.join(" ")).toContain("pin");
    expect(contract.methods["inspectAuthoring"]?.arguments.join(" ")).toContain("parts");
    expect(contract.methods["publishAuthoring"]?.arguments.join(" ")).toContain(
      "expectedFingerprint"
    );
    expect(contract.methods["publishAuthoring"]?.arguments.join(" ")).not.toContain("plan");
    expect(contract.types["TemplateInspection"]).toContain("section, value");
    expect(contract.types["TemplateStatusRow"]).not.toContain("contribution");
    expect(contract.methods["add"]?.arguments.join(" ")).toContain("source:");
    expect(contract.methods["add"]?.arguments.join(" ")).not.toContain("pin");
    expect(prose).toContain("[public contract](public-contract.json)");
    expect(prose).toContain("single protected review");
    expect(invariants).toContain("excluded trust/provider values are optional hints");
    expect(invariants).toContain("separate protected settings action");
    expect(invariants).toContain("staging an isolated context is not separately gated");
    expect(invariants).toContain("without merging historical template content");
  });
});

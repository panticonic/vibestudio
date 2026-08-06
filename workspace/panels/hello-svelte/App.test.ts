import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { compile } from "svelte/compiler";
import { describe, expect, it } from "vitest";

describe("Hello Svelte example", () => {
  it("compiles the shipped Svelte 5 panel contract without warnings", () => {
    const filename = resolve(__dirname, "App.svelte");
    const source = readFileSync(filename, "utf8");
    const compiled = compile(source, {
      filename,
      generate: "client",
      modernAst: true,
    });

    expect(compiled.warnings).toEqual([]);
    expect(source).toContain('from "@workspace/svelte"');
    expect(source).toContain("let count = $state(0)");
    expect(source).toContain("let doubled = $derived(count * 2)");
    expect(source).toContain('aria-label="decrement"');
    expect(compiled.js.code.length).toBeGreaterThan(1_000);
  });
});

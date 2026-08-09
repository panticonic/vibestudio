import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = dirname(fileURLToPath(import.meta.url));

describe("hello-vanilla example", () => {
  it("remains a framework-free panel on the vanilla build path", () => {
    const manifest = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
      vibestudio: { template: string };
      dependencies: Record<string, string>;
    };
    const source = readFileSync(resolve(root, "index.ts"), "utf8");

    expect(manifest.vibestudio.template).toBe("vanilla");
    expect(manifest.dependencies).toEqual({ "@workspace/runtime": "workspace:*" });
    expect(source).toContain('from "@workspace/runtime"');
    expect(source).toContain("document.createElement");
  });
});

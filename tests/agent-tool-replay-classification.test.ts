import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("agent tool replay classification", () => {
  it("keeps a machine-checkable unsafe-by-default replay classification", () => {
    const path = join(process.cwd(), "docs/agent-tool-replay-classification.json");
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      defaultPolicy?: string;
      classes?: Record<string, { replaySafe?: boolean }>;
      surfaces?: Array<{ id?: string; class?: string }>;
    };

    expect(parsed.defaultPolicy).toBe("unsafe");
    expect(parsed.classes?.["unsafe"]?.replaySafe).toBe(false);
    expect(parsed.surfaces?.length).toBeGreaterThan(0);
    for (const surface of parsed.surfaces ?? []) {
      expect(surface.id).toBeTypeOf("string");
      expect(surface.class && parsed.classes?.[surface.class]).toBeTruthy();
    }
    expect(parsed.surfaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "harness.fs.write", class: "unsafe" }),
        expect.objectContaining({ id: "extensions.dynamic-tools", class: "unsafe" }),
      ])
    );
  });
});

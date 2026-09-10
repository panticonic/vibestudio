import { describe, expect, it } from "vitest";
import { composeTemplateLayers, type TemplateLayer } from "./templateComposition.js";

function layer(label: string, files: Record<string, string>): TemplateLayer {
  const bytes = new Map(
    Object.entries(files).map(([path, text]) => [path, new TextEncoder().encode(text)])
  );
  return {
    label,
    files: [...bytes].map(([path, content]) => ({
      path,
      contentHash: `hash-${label}-${path}`,
      size: content.byteLength,
      mode: 0o644 as const,
    })),
    readFile: (path) => bytes.get(path) ?? null,
  };
}

const MANIFEST = "meta/vibestudio.yml";

describe("composeTemplateLayers", () => {
  it("lays a base down before what extends it, and reads each file from its own layer", () => {
    const composed = composeTemplateLayers({
      layers: [
        layer("base", { "panels/chat/index.ts": "base chat" }),
        layer("personal", { "panels/news/index.ts": "personal news" }),
      ],
    });

    expect(composed.files.map((file) => file.path)).toEqual([
      "panels/chat/index.ts",
      "panels/news/index.ts",
    ]);
    expect(new TextDecoder().decode(composed.readFile("panels/chat/index.ts")!)).toBe("base chat");
    expect(new TextDecoder().decode(composed.readFile("panels/news/index.ts")!)).toBe(
      "personal news"
    );
  });

  it("refuses a path two layers both claim, naming both", () => {
    expect(() =>
      composeTemplateLayers({
        layers: [
          layer("base", { "panels/chat/index.ts": "base" }),
          layer("personal", { "panels/chat/index.ts": "personal" }),
        ],
      })
    ).toThrow(/panels\/chat\/index\.ts from both base and personal/u);
  });

  it("leaves a composed path to its caller instead of picking a layer's copy", () => {
    // Every template carries its own manifest, so that path is in every layer
    // and is the one thing composition decides rather than copies.
    const composed = composeTemplateLayers({
      layers: [
        layer("base", { [MANIFEST]: "base manifest", "panels/chat/index.ts": "base" }),
        layer("personal", { [MANIFEST]: "personal manifest" }),
      ],
      composedPaths: [MANIFEST],
    });

    expect(composed.files.map((file) => file.path)).toEqual(["panels/chat/index.ts"]);
    expect(composed.readFile(MANIFEST)).toBeNull();
  });

  it("keeps one layer's tree intact when it is the only one", () => {
    const only = layer("system", { "apps/shell/index.tsx": "shell", "meta/AGENTS.md": "notes" });
    const composed = composeTemplateLayers({ layers: [only] });
    expect(composed.files.map((file) => file.path)).toEqual([
      "apps/shell/index.tsx",
      "meta/AGENTS.md",
    ]);
  });

  it("composes nothing from no layers rather than inventing a tree", () => {
    expect(composeTemplateLayers({ layers: [] })).toMatchObject({ files: [] });
  });
});

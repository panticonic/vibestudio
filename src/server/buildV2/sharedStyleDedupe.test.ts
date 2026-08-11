import { describe, expect, it } from "vitest";
import { build as esbuild, type OnResolveArgs, type PluginBuild } from "esbuild";
import { createSharedStyleDedupePlugin } from "./sharedStyleDedupe.js";

describe("createSharedStyleDedupePlugin", () => {
  it("empties covered imports outside the adapter-owned shared entry", () => {
    const resolves: Array<(args: Pick<OnResolveArgs, "path" | "importer" | "kind">) => unknown> =
      [];
    const loads: Array<() => unknown> = [];
    const plugin = createSharedStyleDedupePlugin([
      "@radix-ui/themes/styles.css",
      "@workspace/ui/tokens.css",
    ]);
    const build = {
      onResolve(
        _options: Parameters<PluginBuild["onResolve"]>[0],
        callback: Parameters<PluginBuild["onResolve"]>[1]
      ) {
        resolves.push(callback as (typeof resolves)[number]);
      },
      onLoad(
        _options: Parameters<PluginBuild["onLoad"]>[0],
        callback: Parameters<PluginBuild["onLoad"]>[1]
      ) {
        loads.push(callback as (typeof loads)[number]);
      },
    } as unknown as PluginBuild;
    plugin.setup(build);

    expect(
      resolves[0]!({
        path: "@radix-ui/themes/styles.css",
        importer: "/workspace/about/ui.tsx",
        kind: "import-statement",
      })
    ).toEqual({
      path: "@radix-ui/themes/styles.css",
      namespace: "vibestudio-covered-shared-style",
    });
    expect(
      resolves[0]!({
        path: "@radix-ui/themes/styles.css",
        importer: "/build/_shared-styles.css",
        kind: "import-rule",
      })
    ).toBeUndefined();
    expect(
      resolves[0]!({
        path: "./launcher.css",
        importer: "/workspace/about/new/index.tsx",
        kind: "import-statement",
      })
    ).toBeUndefined();
    expect(loads[0]!()).toEqual({ contents: "", loader: "css" });
  });

  it("preserves canonical CSS imports in the real esbuild pipeline", async () => {
    const result = await esbuild({
      stdin: {
        contents: '@import "covered.css";',
        loader: "css",
        resolveDir: "/workspace/about/new",
      },
      bundle: true,
      write: false,
      plugins: [
        createSharedStyleDedupePlugin(["covered.css"]),
        {
          name: "covered-style-fixture",
          setup(build) {
            build.onResolve({ filter: /^covered\.css$/ }, () => ({
              path: "covered.css",
              namespace: "fixture",
            }));
            build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
              contents: ".covered { color: red; }",
              loader: "css",
            }));
          },
        },
      ],
    });

    expect(result.errors).toEqual([]);
    expect(result.outputFiles[0]!.text).toContain(".covered");
  });
});

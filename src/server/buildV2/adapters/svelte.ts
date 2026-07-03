import type * as esbuild from "esbuild";
import sveltePlugin from "esbuild-svelte";
import { SVELTE_FRAMEWORK_MODULE } from "../platformModules.js";
import type { FrameworkAdapter } from "./types.js";

export const svelteAdapter: FrameworkAdapter = {
  id: "svelte",

  dedupePackages: ["svelte", "svelte/internal"],

  forcedSplitPackages: [],

  // Svelte uses its own compiler, no JSX
  jsx: undefined,
  tsconfigJsx: undefined,

  plugins(): esbuild.Plugin[] {
    return [
      sveltePlugin({
        compilerOptions: {
          css: "injected",
        },
      }),
    ];
  },

  generateEntry(exposeEntryFile: string, entryFile: string, frameworkModule?: string): string {
    // Auto-mount contract module — see platformModules.FRAMEWORK_MODULES.
    const mountModule = frameworkModule ?? SVELTE_FRAMEWORK_MODULE;
    return `import ${JSON.stringify(exposeEntryFile)};
import { autoMountSveltePanel, shouldAutoMount } from ${JSON.stringify(mountModule)};
import * as userModule from ${JSON.stringify(entryFile)};

if (shouldAutoMount(userModule)) {
  autoMountSveltePanel(userModule);
}
`;
  },

  // Minimal fallback HTML
  cdnStylesheets: [],
  additionalCss: "",
  rootElementHtml: '<div id="root"></div>',
};

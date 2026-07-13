import { REACT_FRAMEWORK_MODULE } from "../platformModules.js";
import type { FrameworkAdapter } from "./types.js";

export const reactAdapter: FrameworkAdapter = {
  id: "react",

  dedupePackages: ["react", "react-dom", "react/jsx-runtime", "react/jsx-dev-runtime"],

  jsx: "automatic",
  tsconfigJsx: "react-jsx",

  generateEntry(exposeEntryFile: string, entryFile: string, frameworkModule?: string): string {
    // Auto-mount contract module — see platformModules.FRAMEWORK_MODULES.
    const mountModule = frameworkModule ?? REACT_FRAMEWORK_MODULE;
    return `import "@radix-ui/themes/styles.css";
import ${JSON.stringify(exposeEntryFile)};
import { autoMountReactPanel, shouldAutoMount } from ${JSON.stringify(mountModule)};
import * as userModule from ${JSON.stringify(entryFile)};

if (shouldAutoMount(userModule)) {
  autoMountReactPanel(userModule);
}
`;
  },

  // Fallback HTML defaults (used only when no workspace template is found).
  // Radix CSS is imported into the generated entry above so panel loads do not
  // depend on a third-party CDN at runtime.
  cdnStylesheets: [],
  additionalCss: "#root, #root > .radix-themes { min-height: 100dvh; }",
  rootElementHtml: '<div id="root"></div>',
};

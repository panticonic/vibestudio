import { REACT_FRAMEWORK_ENTRY_MODULE } from "../platformModules.js";
import type { FrameworkAdapter } from "./types.js";

export const reactAdapter: FrameworkAdapter = {
  id: "react",

  dedupePackages: [
    "react",
    "react-dom",
    "react/jsx-runtime",
    "react/jsx-dev-runtime",
    "@radix-ui/react-icons",
    "@radix-ui/themes",
  ],

  sharedStyles: ["@radix-ui/themes/styles.css", "@workspace/ui/tokens.css"],

  jsx: "automatic",
  tsconfigJsx: "react-jsx",

  generateEntry(exposeEntryFile: string, entryFile: string, frameworkModule?: string): string {
    // Auto-mount contract module — see platformModules.FRAMEWORK_MODULES.
    const mountModule = frameworkModule ?? REACT_FRAMEWORK_ENTRY_MODULE;
    return `import ${JSON.stringify(exposeEntryFile)};
import { autoMountReactPanel, shouldAutoMount } from ${JSON.stringify(mountModule)};
import * as userModule from ${JSON.stringify(entryFile)};

if (shouldAutoMount(userModule)) {
  autoMountReactPanel(userModule);
}
`;
  },

  // Fallback HTML defaults (used only when no workspace template is found).
  // Shared base CSS is emitted by the builder as a content-addressed asset, so
  // panel loads do not depend on a third-party CDN at runtime.
  cdnStylesheets: [],
  additionalCss: "#root, #root > .radix-themes { min-height: 100dvh; }",
  rootElementHtml: '<div id="root"></div>',
};

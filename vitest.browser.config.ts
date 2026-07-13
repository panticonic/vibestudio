import { defineConfig } from "vitest/config";
import path from "path";
import { workspaceSourceAliases } from "./vitest.sourceAliases";

// Browser-mode test project. Opened Radix overlays (Dialog/DropdownMenu/Popover/
// HoverCard) can't render under jsdom: pnpm `node-linker=hoisted` leaves two
// path-distinct React copies (hoisted vs nested .pnpm), and the externalized
// overlay sidecars (react-remove-scroll, …) load the second one, so hooks crash
// with a null dispatcher the moment a portal mounts. No vitest alias/dedupe/
// inline combination fixes that (the CJS sidecars resist SSR transform). A real
// browser bundles ONE React, so the overlays open correctly. The jsdom suite
// (vitest.config.ts) excludes *.browser.test.tsx; this config runs only those.

export default defineConfig({
  resolve: {
    alias: [
      ...workspaceSourceAliases(__dirname),
      { find: "ignore", replacement: path.resolve(__dirname, "node_modules/ignore") },
      { find: "picomatch", replacement: path.resolve(__dirname, "node_modules/picomatch") },
    ],
    dedupe: ["react", "react-dom"],
  },
  test: {
    globals: true,
    include: [
      "workspace/**/*.browser.test.tsx",
      "packages/**/*.browser.test.tsx",
      "src/**/*.browser.test.tsx",
    ],
    exclude: [
      "**/node_modules/**",
      "dist",
      "workspace/.contexts",
      "apps/mobile/**",
      "workspace/apps/mobile/**",
    ],
    browser: {
      enabled: true,
      provider: "playwright",
      headless: true,
      instances: [{ browser: "chromium" }],
    },
  },
});

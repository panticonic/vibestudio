import { defineConfig } from "vitest/config";
import { workspaceSourceAliases } from "./vitest.sourceAliases";
import { userlandDependencyAliases } from "./vitest.userlandProjection";

// Browser-mode test project. Opened Radix overlays (Dialog/DropdownMenu/Popover/
// HoverCard) exercise externalized CJS sidecars that do not faithfully model a
// browser bundle under jsdom. A real browser bundles one React dispatcher, so
// these tests run here; the jsdom suite excludes *.browser.test.tsx.

export default defineConfig(async () => ({
  resolve: {
    alias: [...workspaceSourceAliases(__dirname), ...(await userlandDependencyAliases(__dirname))],
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
      "workspace/.context-projections",
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
}));

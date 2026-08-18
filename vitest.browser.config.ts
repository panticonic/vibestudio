import { defineConfig } from "vitest/config";
import path from "node:path";
import {
  discoveredUserlandSourceAliases,
  workspaceSourceAliases,
} from "./vitest.sourceAliases";
import { userlandDependencyAliases } from "./vitest.userlandProjection";
import { prepareUserlandDependencyProjection } from "./scripts/lib/userland-dependency-projection";
import { requireDevelopmentBaseCheckout } from "./src/dev/developmentBaseConfig";

// Browser-mode test project. Opened Radix overlays (Dialog/DropdownMenu/Popover/
// HoverCard) exercise externalized CJS sidecars that do not faithfully model a
// browser bundle under jsdom. A real browser bundles one React dispatcher, so
// these tests run here; the jsdom suite excludes *.browser.test.tsx.

export default defineConfig(async () => {
  const workspaceRoot = requireDevelopmentBaseCheckout(__dirname);
  const dependencyProjection = await prepareUserlandDependencyProjection({
    appRoot: __dirname,
    workspaceRoot,
    includeDevelopmentDependencies: true,
  });
  return {
    resolve: {
      alias: [
        ...(await userlandDependencyAliases(__dirname, workspaceRoot)),
        ...discoveredUserlandSourceAliases(dependencyProjection.units),
        ...workspaceSourceAliases(__dirname, workspaceRoot),
      ],
      dedupe: ["react", "react-dom"],
    },
    server: {
      fs: {
        // Browser-mode tests and their snapshots live in the exact external
        // Base checkout, outside the host Vite root.
        allow: [__dirname, workspaceRoot],
      },
    },
    test: {
      globals: true,
      include: [
        `${path
          .relative(__dirname, workspaceRoot)
          .replaceAll(path.sep, "/")}/**/*.browser.test.{ts,tsx}`,
        "packages/**/*.browser.test.tsx",
        "src/**/*.browser.test.tsx",
      ],
      exclude: ["**/node_modules/**", "dist", "apps/mobile/**"],
      browser: {
        enabled: true,
        provider: "playwright",
        headless: true,
        instances: [{ browser: "chromium" }],
      },
    },
  };
});

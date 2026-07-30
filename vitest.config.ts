import { defineConfig } from "vitest/config";
import path from "path";
import { workspaceSourceAliases } from "./vitest.sourceAliases";
import { vitestSharedConfig } from "./vitest.sharedConfig";

export default defineConfig({
  ...vitestSharedConfig,
  resolve: {
    ...vitestSharedConfig.resolve,
    alias: [
      ...vitestSharedConfig.resolve.alias,
      ...workspaceSourceAliases(__dirname),
      // Resolve workspace panel dependencies from the hoisted node_modules
      // (version-agnostic — the versioned .pnpm store paths go stale on
      // every dependency bump). Needed for tests in workspace/panels/ which
      // aren't pnpm workspace packages.
      {
        find: "ignore",
        replacement: path.resolve(__dirname, "node_modules/ignore"),
      },
      {
        find: "picomatch",
        replacement: path.resolve(__dirname, "node_modules/picomatch"),
      },
    ],
  },
  test: {
    ...vitestSharedConfig.test,
    globals: true,
    include: [
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "workspace/**/*.test.ts",
      "workspace/**/*.test.tsx",
      "packages/**/*.test.ts",
      "packages/**/*.test.tsx",
      "tests/**/*.test.ts",
      "tests/**/*.test.tsx",
      "apps/**/*.test.ts",
      "apps/**/*.test.tsx",
    ],
  },
});

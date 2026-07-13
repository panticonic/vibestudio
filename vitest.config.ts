import { defineConfig } from "vitest/config";
import path from "path";
import { workspaceSourceAliases } from "./vitest.sourceAliases";

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^react$/,
        replacement: path.resolve(__dirname, "node_modules/react/index.js"),
      },
      {
        find: /^react\/(.+)$/,
        replacement: path.resolve(__dirname, "node_modules/react/$1"),
      },
      {
        find: /^react-dom$/,
        replacement: path.resolve(__dirname, "node_modules/react-dom/index.js"),
      },
      {
        find: /^react-dom\/(.+)$/,
        replacement: path.resolve(__dirname, "node_modules/react-dom/$1"),
      },
      {
        find: /^react-native$/,
        replacement: path.resolve(__dirname, "tests/stubs/reactNative.ts"),
      },
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
    // Force a single React instance across the test graph. The repo has
    // BOTH `node_modules/react` (hoisted) and
    // `node_modules/.pnpm/react@19.2.3/node_modules/react` (canonical pnpm),
    // and the files inside are hardlinks — same inode, different path
    // strings. Node's module system keys by path, so different importers
    // can each end up with their own React module record. The dispatcher
    // (ReactSharedInternals.H) gets set on one copy but read from the
    // other, and hooks crash with "Cannot read properties of null
    // (reading 'useState' / 'useSyncExternalStore')". `dedupe` makes Vite
    // always resolve react to the same path; `server.deps.inline` below
    // makes the same true for code in node_modules.
    dedupe: ["react", "react-dom"],
  },
  test: {
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
    exclude: [
      "**/node_modules/**",
      "dist",
      "workspace/.contexts",
      "apps/mobile/**",
      "workspace/apps/mobile/**",
      // Browser-mode tests (opened Radix overlays that can't render in jsdom)
      // run under vitest.browser.config.ts in a real browser instead.
      "**/*.browser.test.tsx",
    ],
    // Absolute so vitest also works when invoked from a package subdirectory
    // (a relative path here resolves against the invocation cwd).
    setupFiles: [path.resolve(__dirname, "tests/setup/vitest.setup.ts")],
    server: {
      deps: {
        // Inline Radix so its imports go through Vite's transform pipeline,
        // where `resolve.dedupe` above can rewrite their `react` imports
        // to the same canonical path used elsewhere. Without inlining,
        // Node's CJS resolver finds React via the deeply-nested pnpm
        // symlink chain (which is hardlinked to but path-distinct from the
        // hoisted `node_modules/react`), so we end up with two React module
        // records and hooks crash with "Cannot read properties of null
        // (reading 'useState')". Patterns match against the resolved file
        // path, not the import specifier, so we anchor on the .pnpm folder.
        inline: [
          /node_modules\/\.pnpm\/@radix-ui\+/,
          /node_modules\/\.pnpm\/radix-ui@/,
          /node_modules\/\.pnpm\/jotai@/,
          /node_modules\/use-stick-to-bottom/,
        ],
      },
    },
  },
});

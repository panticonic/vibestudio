import path from "node:path";

export const vitestSharedConfig = {
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
        find: /^@testing-library\/react$/,
        replacement: path.resolve(__dirname, "node_modules/@testing-library/react/dist/index.js"),
      },
      {
        find: /^@testing-library\/react\/(.+)$/,
        replacement: path.resolve(__dirname, "node_modules/@testing-library/react/$1"),
      },
      // Workspace-owned shared React components resolve Radix from
      // workspace/node_modules. Keep Radix on the same physical React module
      // as the renderer, just as the explicit React aliases above do.
      {
        find: /^@radix-ui\/themes$/,
        replacement: path.resolve(__dirname, "node_modules/@radix-ui/themes/dist/esm/index.js"),
      },
      // Radix's scroll-lock helpers are CJS. When they come from the workspace
      // package store, their inner `require("react")` is resolved by Node from
      // their own directory — Vite's `react` alias never sees it — so they bind
      // to a SECOND copy of React whose dispatcher is null in this runner, and
      // every hook inside a mounted Radix dialog throws. Pinning the helpers
      // themselves to the root copy fixes the resolution at its source: the
      // root copy's own `require("react")` lands on the same React everything
      // else here uses.
      {
        find: /^(react-remove-scroll|react-remove-scroll-bar|use-sidecar|use-callback-ref)$/,
        replacement: path.resolve(__dirname, "node_modules/$1"),
      },
      {
        find: /^react-native$/,
        replacement: path.resolve(__dirname, "tests/stubs/reactNative.ts"),
      },
    ],
    dedupe: ["react", "react-dom"],
  },
  test: {
    globals: true,
    exclude: [
      "**/node_modules/**",
      "dist",
      "workspace/.context-projections",
      "workspace/.contexts",
      "apps/mobile/**",
      "workspace/apps/mobile/**",
      "**/*.browser.test.tsx",
    ],
    setupFiles: [path.resolve(__dirname, "tests/setup/vitest.setup.ts")],
    server: {
      deps: {
        inline: [
          /node_modules\/\.pnpm\/@radix-ui\+/,
          /node_modules\/\.pnpm\/radix-ui@/,
          /node_modules\/\.pnpm\/jotai@/,
          /node_modules\/@testing-library\/react/,
          /node_modules\/react-dom/,
          /node_modules\/use-stick-to-bottom/,
        ],
      },
    },
  },
} as const;

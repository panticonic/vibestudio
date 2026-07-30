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

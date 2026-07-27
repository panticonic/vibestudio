import { defineConfig } from "vitest/config";
import path from "node:path";
import baseConfig from "./vitest.config";

const base = baseConfig as {
  test?: {
    exclude?: string[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    name: "host",
    reporters: [
      "default",
      [
        path.resolve(__dirname, "scripts/runtime-foundation-evidence-reporter.mjs"),
        { project: "host", root: __dirname },
      ],
    ],
    include: [
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "packages/**/*.test.ts",
      "packages/**/*.test.tsx",
      "tests/**/*.test.ts",
      "tests/**/*.test.tsx",
      "apps/**/*.test.ts",
      "apps/**/*.test.tsx",
    ],
    exclude: [...(base.test?.exclude ?? []), "workspace/**", "tests/workspace-integration/**"],
  },
});

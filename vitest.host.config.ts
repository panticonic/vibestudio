import { defineConfig } from "vitest/config";
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

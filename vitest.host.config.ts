import { defineConfig } from "vitest/config";
import path from "node:path";
import { vitestSharedConfig } from "./vitest.sharedConfig";
import { exactPairTests } from "./vitest.exactPairTests";

export default defineConfig({
  ...vitestSharedConfig,
  test: {
    ...vitestSharedConfig.test,
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
    exclude: [
      ...vitestSharedConfig.test.exclude,
      "workspace/**",
      "tests/workspace-integration/**",
      ...exactPairTests,
    ],
  },
});

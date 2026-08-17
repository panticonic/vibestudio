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
    // The host suite exercises real SQLite stores, workerd processes, and
    // build graphs. Their isolated tests are bounded, but unbounded file
    // parallelism can starve both the five-second default deadline and
    // Vitest's worker heartbeat. Match the proven userland scheduling budget
    // so machine core count is not a correctness dependency.
    testTimeout: 30_000,
    maxWorkers: 4,
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

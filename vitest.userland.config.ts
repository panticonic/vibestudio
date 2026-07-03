import { defineConfig } from "vitest/config";
import baseConfig from "./vitest.config";

const base = baseConfig as {
  test?: Record<string, unknown>;
  [key: string]: unknown;
};

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: ["workspace/**/*.test.ts", "workspace/**/*.test.tsx"],
  },
});

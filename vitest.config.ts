import { defineConfig } from "vitest/config";
import { workspaceSourceAliases } from "./vitest.sourceAliases";
import { vitestSharedConfig } from "./vitest.sharedConfig";
import { userlandDependencyAliases } from "./vitest.userlandProjection";

export default defineConfig(async () => {
  const projectedDependencies = await userlandDependencyAliases(__dirname);
  return {
    ...vitestSharedConfig,
    resolve: {
      ...vitestSharedConfig.resolve,
      alias: [
        ...vitestSharedConfig.resolve.alias,
        ...workspaceSourceAliases(__dirname),
        ...projectedDependencies,
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
  };
});

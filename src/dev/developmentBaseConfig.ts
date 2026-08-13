import { createRequire } from "node:module";

const config = createRequire(import.meta.url)("./developmentBaseConfig.cjs") as {
  DEVELOPMENT_BASE_GIT_CONFIG_KEY: string;
  configuredDevelopmentBaseCheckout(repoRoot: string, env?: NodeJS.ProcessEnv): string | undefined;
  requireDevelopmentBaseCheckout(repoRoot: string, env?: NodeJS.ProcessEnv): string;
  selectDevelopmentBaseCheckout(
    repoRoot: string,
    options?: {
      explicitCheckout?: string;
      productionBase?: boolean;
      env?: NodeJS.ProcessEnv;
    }
  ): string | undefined;
  setDevelopmentBaseCheckout(repoRoot: string, checkout: string): string;
  clearDevelopmentBaseCheckout(repoRoot: string): void;
  canonicalCheckout(checkout: string): string;
  assertGitCheckout(checkout: string): void;
  developmentBaseHead(checkout: string): { commit: string; dirty: boolean };
};

export const {
  DEVELOPMENT_BASE_GIT_CONFIG_KEY,
  configuredDevelopmentBaseCheckout,
  requireDevelopmentBaseCheckout,
  selectDevelopmentBaseCheckout,
  setDevelopmentBaseCheckout,
  clearDevelopmentBaseCheckout,
  canonicalCheckout,
  assertGitCheckout,
  developmentBaseHead,
} = config;

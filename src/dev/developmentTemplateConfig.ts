import { createRequire } from "node:module";
import type { DefaultWorkspaceTemplates } from "@vibestudio/workspace/templateRelease";

export interface DevelopmentTemplateCheckouts {
  root: string;
  registry: string;
  sources: DevelopmentTemplateSource[];
  checkouts: Record<string, string> & Record<keyof DefaultWorkspaceTemplates, string>;
}

export interface DevelopmentTemplateSource {
  id: string;
  role: keyof DefaultWorkspaceTemplates | "development" | "catalog";
  name: string;
  description: string;
  url: string;
  tags?: string[];
  recommended?: boolean;
  consumers?: Array<keyof DefaultWorkspaceTemplates>;
}

const config = createRequire(import.meta.url)("./developmentTemplateConfig.cjs") as {
  DEVELOPMENT_TEMPLATE_ROOT_GIT_CONFIG_KEY: string;
  DEVELOPMENT_TEMPLATE_ROOT_ENV: string;
  DEFAULT_TEMPLATE_NAMES: readonly (keyof DefaultWorkspaceTemplates)[];
  TEMPLATE_REGISTRY_RELATIVE_PATH: string;
  configuredDevelopmentTemplateRoot(repoRoot: string, env?: NodeJS.ProcessEnv): string | undefined;
  requireDevelopmentTemplateCheckouts(
    repoRoot: string,
    env?: NodeJS.ProcessEnv
  ): DevelopmentTemplateCheckouts;
  requireDevelopmentTemplateCheckout(
    repoRoot: string,
    name: string,
    env?: NodeJS.ProcessEnv
  ): string;
  readOfficialTemplateCatalog(registryFile: string): {
    registry: string;
    sources: DevelopmentTemplateSource[];
  };
  selectDevelopmentTemplateCheckouts(
    repoRoot: string,
    options?: { explicitRoot?: string; productionTemplates?: boolean; env?: NodeJS.ProcessEnv }
  ): DevelopmentTemplateCheckouts | undefined;
  setDevelopmentTemplateRoot(repoRoot: string, root: string): DevelopmentTemplateCheckouts;
  clearDevelopmentTemplateRoot(repoRoot: string): void;
  templateCheckoutsForRepo(repoRoot: string, root: string): DevelopmentTemplateCheckouts;
  canonicalRoot(root: string): string;
  assertGitCheckout(checkout: string, name?: string): void;
  developmentTemplateHead(checkout: string): { commit: string; dirty: boolean };
};

export const {
  DEVELOPMENT_TEMPLATE_ROOT_GIT_CONFIG_KEY,
  DEVELOPMENT_TEMPLATE_ROOT_ENV,
  DEFAULT_TEMPLATE_NAMES,
  TEMPLATE_REGISTRY_RELATIVE_PATH,
  configuredDevelopmentTemplateRoot,
  readOfficialTemplateCatalog,
  requireDevelopmentTemplateCheckouts,
  requireDevelopmentTemplateCheckout,
  selectDevelopmentTemplateCheckouts,
  setDevelopmentTemplateRoot,
  clearDevelopmentTemplateRoot,
  templateCheckoutsForRepo,
  canonicalRoot,
  assertGitCheckout,
  developmentTemplateHead,
} = config;

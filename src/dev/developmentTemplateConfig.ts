import { createRequire } from "node:module";
import type { DefaultWorkspaceTemplates } from "@vibestudio/workspace/templateRelease";

export interface DevelopmentTemplateCheckouts {
  root: string;
  checkouts: Record<keyof DefaultWorkspaceTemplates, string>;
  /** Templates present to be depended on rather than installed as a root. */
  dependencies: Partial<Record<DependencyTemplateName, string>>;
}

export type DependencyTemplateName = "system-testing";

const config = createRequire(import.meta.url)("./developmentTemplateConfig.cjs") as {
  DEVELOPMENT_TEMPLATE_ROOT_GIT_CONFIG_KEY: string;
  DEVELOPMENT_TEMPLATE_ROOT_ENV: string;
  TEMPLATE_NAMES: readonly (keyof DefaultWorkspaceTemplates)[];
  DEPENDENCY_TEMPLATE_NAMES: readonly DependencyTemplateName[];
  DEPENDENCY_TEMPLATE_URLS: Record<DependencyTemplateName, string>;
  configuredDevelopmentTemplateRoot(repoRoot: string, env?: NodeJS.ProcessEnv): string | undefined;
  requireDevelopmentTemplateCheckouts(
    repoRoot: string,
    env?: NodeJS.ProcessEnv
  ): DevelopmentTemplateCheckouts;
  requireDevelopmentTemplateCheckout(
    repoRoot: string,
    name: keyof DefaultWorkspaceTemplates,
    env?: NodeJS.ProcessEnv
  ): string;
  selectDevelopmentTemplateCheckouts(
    repoRoot: string,
    options?: { explicitRoot?: string; productionTemplates?: boolean; env?: NodeJS.ProcessEnv }
  ): DevelopmentTemplateCheckouts | undefined;
  setDevelopmentTemplateRoot(repoRoot: string, root: string): DevelopmentTemplateCheckouts;
  clearDevelopmentTemplateRoot(repoRoot: string): void;
  templateCheckouts(root: string): DevelopmentTemplateCheckouts;
  canonicalRoot(root: string): string;
  assertGitCheckout(checkout: string, name?: string): void;
  developmentTemplateHead(checkout: string): { commit: string; dirty: boolean };
};

export const {
  DEVELOPMENT_TEMPLATE_ROOT_GIT_CONFIG_KEY,
  DEVELOPMENT_TEMPLATE_ROOT_ENV,
  TEMPLATE_NAMES,
  DEPENDENCY_TEMPLATE_NAMES,
  DEPENDENCY_TEMPLATE_URLS,
  configuredDevelopmentTemplateRoot,
  requireDevelopmentTemplateCheckouts,
  requireDevelopmentTemplateCheckout,
  selectDevelopmentTemplateCheckouts,
  setDevelopmentTemplateRoot,
  clearDevelopmentTemplateRoot,
  templateCheckouts,
  canonicalRoot,
  assertGitCheckout,
  developmentTemplateHead,
} = config;

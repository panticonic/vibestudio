import { z } from "zod";
import { readDefaultWorkspaceTemplates } from "@vibestudio/workspace/templateRelease";
import { WorkspaceTemplatePinSchema } from "@vibestudio/workspace-contracts/workspaceConfigSchema";
import { sameWorkspaceTemplatePin } from "@vibestudio/workspace-contracts/types";

/** Artifact preparation covers selected roots; workspace creation still uses only its built-in defaults. */
export const WORKSPACE_PREPARATION_TEMPLATES_ENV = "VIBESTUDIO_PREPARE_WORKSPACE_TEMPLATES";
export const workspacePreparationNameSchema = z.string().regex(/^[a-z][a-z0-9-]*$/u);
export const workspacePreparationTemplatesSchema = z
  .record(workspacePreparationNameSchema, WorkspaceTemplatePinSchema)
  .refine(
    (value) => ["base", "personal", "system"].every((name) => Object.hasOwn(value, name)),
    "Preparation requires all three built-in workspace roots"
  );
export type WorkspacePreparationTemplates = z.infer<typeof workspacePreparationTemplatesSchema>;
export function readWorkspacePreparationTemplates(
  appRoot: string,
  env: NodeJS.ProcessEnv = process.env
): WorkspacePreparationTemplates {
  const defaults = readDefaultWorkspaceTemplates(appRoot, env),
    configured = env[WORKSPACE_PREPARATION_TEMPLATES_ENV]?.trim();
  const templates = configured
    ? workspacePreparationTemplatesSchema.parse(JSON.parse(configured))
    : defaults;
  for (const name of ["base", "personal", "system"] as const)
    if (!sameWorkspaceTemplatePin(templates[name]!, defaults[name]))
      throw new Error(`Prepared ${name} root differs from the default workspace template`);
  return templates;
}

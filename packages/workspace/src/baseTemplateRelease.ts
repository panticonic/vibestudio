import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRuntimeLayout } from "@vibestudio/shared/runtimePaths";
import { WorkspaceTemplatePinSchema } from "@vibestudio/workspace-contracts/workspaceConfigSchema";
import type { WorkspaceTemplatePin } from "@vibestudio/workspace-contracts/types";

export const BASE_TEMPLATE_RELEASE_ARTIFACT = "base-template-release.json" as const;

const BaseTemplateReleaseArtifactSchema = z
  .object({
    format: z.literal("vibestudio-base-release/1"),
    baseTemplate: WorkspaceTemplatePinSchema,
  })
  .strict();

export interface BaseTemplateReleaseArtifact {
  format: "vibestudio-base-release/1";
  baseTemplate: WorkspaceTemplatePin;
}

export type ParsedBaseTemplateRelease = BaseTemplateReleaseArtifact;

export function parseBaseTemplateReleaseArtifact(value: unknown): ParsedBaseTemplateRelease {
  return BaseTemplateReleaseArtifactSchema.parse(value) as BaseTemplateReleaseArtifact;
}

export function baseTemplateReleaseCandidates(appRoot: string): string[] {
  const layout = createRuntimeLayout(appRoot);
  return [
    path.join(layout.resourcesRoot, BASE_TEMPLATE_RELEASE_ARTIFACT),
    path.join(layout.appRoot, "build-resources", BASE_TEMPLATE_RELEASE_ARTIFACT),
  ].filter((candidate, index, all) => all.indexOf(candidate) === index);
}

export function readBaseTemplateRelease(appRoot: string): ParsedBaseTemplateRelease {
  for (const candidate of baseTemplateReleaseCandidates(appRoot)) {
    if (!fs.existsSync(candidate)) continue;
    return parseBaseTemplateReleaseArtifact(JSON.parse(fs.readFileSync(candidate, "utf8")));
  }
  throw new Error("This host build has no exact external Base release pointer");
}

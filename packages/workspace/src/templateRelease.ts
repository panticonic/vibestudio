import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import { createRuntimeLayout } from "@vibestudio/shared/runtimePaths";
import { WorkspaceTemplatePinSchema } from "@vibestudio/workspace-contracts/workspaceConfigSchema";
import { normalizeTemplateGitUrl } from "./templateCoordinates.js";
import {
  sameWorkspaceTemplatePin,
  type WorkspaceTemplatePin,
} from "@vibestudio/workspace-contracts/types";

export const TEMPLATE_RELEASE_ARTIFACT = "workspace-template-release.json" as const;
export const INITIAL_WORKSPACE_TEMPLATE_ENV = "VIBESTUDIO_INITIAL_WORKSPACE_TEMPLATE" as const;
export const DEFAULT_WORKSPACE_TEMPLATES_ENV = "VIBESTUDIO_DEFAULT_WORKSPACE_TEMPLATES" as const;

export const DefaultWorkspaceTemplatesSchema = z
  .object({
    base: WorkspaceTemplatePinSchema,
    personal: WorkspaceTemplatePinSchema,
    system: WorkspaceTemplatePinSchema,
  })
  .strict();

export type DefaultWorkspaceTemplates = z.infer<typeof DefaultWorkspaceTemplatesSchema>;

const TemplateReleaseArtifactSchema = z
  .object({
    format: z.literal("vibestudio-template-release/1"),
    workspaceTemplates: DefaultWorkspaceTemplatesSchema,
  })
  .strict();

export interface TemplateReleaseArtifact {
  format: "vibestudio-template-release/1";
  workspaceTemplates: DefaultWorkspaceTemplates;
}

export type ParsedTemplateRelease = TemplateReleaseArtifact;

export { sameWorkspaceTemplatePin };

export function parseTemplateReleaseArtifact(value: unknown): ParsedTemplateRelease {
  return TemplateReleaseArtifactSchema.parse(value) as TemplateReleaseArtifact;
}

export function templateReleaseCandidates(appRoot: string): string[] {
  const layout = createRuntimeLayout(appRoot);
  return [
    path.join(layout.resourcesRoot, TEMPLATE_RELEASE_ARTIFACT),
    path.join(layout.appRoot, "build-resources", TEMPLATE_RELEASE_ARTIFACT),
  ].filter((candidate, index, all) => all.indexOf(candidate) === index);
}

export function readTemplateRelease(appRoot: string): ParsedTemplateRelease {
  for (const candidate of templateReleaseCandidates(appRoot)) {
    if (!fs.existsSync(candidate)) continue;
    return parseTemplateReleaseArtifact(JSON.parse(fs.readFileSync(candidate, "utf8")));
  }
  throw new Error("This host build has no exact workspace template release pointer");
}

/** Default templates are exact source pins; their manifests declare dependencies. */
export function readDefaultWorkspaceTemplates(
  appRoot: string,
  environment: NodeJS.ProcessEnv = process.env
): DefaultWorkspaceTemplates {
  const configured = environment[DEFAULT_WORKSPACE_TEMPLATES_ENV]?.trim();
  if (configured) return DefaultWorkspaceTemplatesSchema.parse(JSON.parse(configured));
  return readTemplateRelease(appRoot).workspaceTemplates;
}

/**
 * The template sources this host build designates as its own.
 *
 * A unit that arrives unmodified from one of these is the code Vibestudio
 * ships; anything else is a workspace's own source, whatever it calls itself.
 * Matching is by URL rather than commit, so a template published after
 * this host still counts: the host and its userland release on separate
 * cadences, and the canonical source is already the authority for the code
 * this host runs.
 */
export function hostDesignatedTemplateUrls(
  appRoot: string,
  environment: NodeJS.ProcessEnv = process.env
): ReadonlySet<string> {
  const urls = new Set<string>();
  const add = (url: string): void => {
    urls.add(normalizeTemplateGitUrl(url));
  };
  // A host with no release pointer designates nothing rather than failing:
  // that is a build that cannot claim
  // any unit ships with it, which is exactly the safe answer.
  try {
    for (const pin of Object.values(readDefaultWorkspaceTemplates(appRoot, environment))) {
      add(pin.url);
    }
  } catch {
    /* no template pins in reach */
  }
  return urls;
}

/**
 * Resolve the exact Base template used when creating a generic workspace.
 * Development launchers may replace the packaged release with their sealed
 * checkout snapshot; every host that records or consumes the creation intent
 * must use this same coordinate.
 */
export function readWorkspaceCreationTemplate(
  appRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
  options: { allowInitialOverride?: boolean } = {}
): WorkspaceTemplatePin {
  const initialPin = environment[INITIAL_WORKSPACE_TEMPLATE_ENV]?.trim();
  if (initialPin && options.allowInitialOverride) {
    return WorkspaceTemplatePinSchema.parse(JSON.parse(initialPin));
  }
  return readDefaultWorkspaceTemplates(appRoot, environment).base;
}

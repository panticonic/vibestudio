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

export const BASE_TEMPLATE_RELEASE_ARTIFACT = "base-template-release.json" as const;
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

const BaseTemplateReleaseArtifactSchema = z
  .object({
    format: z.literal("vibestudio-base-release/1"),
    baseTemplate: WorkspaceTemplatePinSchema,
    workspaceTemplates: DefaultWorkspaceTemplatesSchema.optional(),
  })
  .strict();

export interface BaseTemplateReleaseArtifact {
  format: "vibestudio-base-release/1";
  baseTemplate: WorkspaceTemplatePin;
  workspaceTemplates?: DefaultWorkspaceTemplates;
}

export type ParsedBaseTemplateRelease = BaseTemplateReleaseArtifact;

export { sameWorkspaceTemplatePin };

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

/** Default distributions are exact source pins, never live workspace dependencies. */
export function readDefaultWorkspaceTemplates(
  appRoot: string,
  environment: NodeJS.ProcessEnv = process.env
): DefaultWorkspaceTemplates {
  const configured = environment[DEFAULT_WORKSPACE_TEMPLATES_ENV]?.trim();
  if (configured) return DefaultWorkspaceTemplatesSchema.parse(JSON.parse(configured));
  const templates = readBaseTemplateRelease(appRoot).workspaceTemplates;
  if (!templates) {
    throw new Error("This host build has no exact Base, Personal and System distribution pins");
  }
  return templates;
}

/**
 * The template sources this host build designates as its own.
 *
 * A unit that arrives unmodified from one of these is the code Vibestudio
 * ships; anything else is a workspace's own source, whatever it calls itself.
 * Matching is by URL rather than commit, so a distribution published after
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
  // A host with no release pointer, or none of the three distribution pins,
  // designates nothing rather than failing: that is a build that cannot claim
  // any unit ships with it, which is exactly the safe answer.
  try {
    add(readBaseTemplateRelease(appRoot).baseTemplate.url);
  } catch {
    /* no release pointer in reach */
  }
  try {
    for (const pin of Object.values(readDefaultWorkspaceTemplates(appRoot, environment))) {
      add(pin.url);
    }
  } catch {
    /* no distribution pins in reach */
  }
  return urls;
}

/**
 * Resolve the exact Base used when creating a workspace in this process.
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
  const developmentPin = readDevelopmentWorkspaceTemplate(environment);
  if (developmentPin && environment["NODE_ENV"] === "development") {
    return developmentPin;
  }
  return readBaseTemplateRelease(appRoot).baseTemplate;
}

/**
 * Read the exact pin supplied with a local checkout acquisition source.
 * The presence of this source does not itself select the pin for creation;
 * callers use it only to satisfy or validate an independently selected intent.
 */
export function readDevelopmentWorkspaceTemplate(
  environment: NodeJS.ProcessEnv = process.env
): WorkspaceTemplatePin | null {
  const raw = environment["VIBESTUDIO_DEV_ROOT_TEMPLATE"]?.trim();
  return raw ? WorkspaceTemplatePinSchema.parse(JSON.parse(raw)) : null;
}

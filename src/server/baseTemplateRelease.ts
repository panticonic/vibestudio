import * as fs from "node:fs";
import * as path from "node:path";
import { canonicalJson, sha256HexSyncText } from "@vibestudio/content-addressing";
import { createRuntimeLayout } from "@vibestudio/shared/runtimePaths";
import {
  BASE_TEMPLATE_RELEASE_ARTIFACT,
  parseBaseTemplateReleaseArtifact,
  type ParsedBaseTemplateRelease,
} from "@vibestudio/workspace/baseTemplateRelease";
import { normalizeTemplateGitUrl } from "@vibestudio/workspace/templateCoordinates";
import type {
  WorkspaceTemplateState,
  WorkspaceTemplatePin,
} from "@vibestudio/workspace-contracts/types";

export interface BaseTemplateReleasePull {
  commandId: string;
  alias: string;
  pin: WorkspaceTemplatePin;
}

export function baseTemplateReleaseCandidates(appRoot: string): string[] {
  const layout = createRuntimeLayout(appRoot);
  return [
    path.join(layout.resourcesRoot, BASE_TEMPLATE_RELEASE_ARTIFACT),
    path.join(layout.appRoot, "build-resources", BASE_TEMPLATE_RELEASE_ARTIFACT),
  ].filter((candidate, index, all) => all.indexOf(candidate) === index);
}

/** Read only host-shipped bytes. The mutable workspace copy is never a rescue input. */
export function readBaseTemplateRelease(appRoot: string): ParsedBaseTemplateRelease | null {
  for (const candidate of baseTemplateReleaseCandidates(appRoot)) {
    if (!fs.existsSync(candidate)) continue;
    return parseBaseTemplateReleaseArtifact(JSON.parse(fs.readFileSync(candidate, "utf8")));
  }
  return null;
}

function samePin(left: WorkspaceTemplatePin, right: WorkspaceTemplatePin): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

/**
 * Compare the current committed lineage with the host release unit. A differing
 * exact pin becomes an ordinary Composer pull; no host migration service or
 * privileged publication path is introduced.
 */
export function baseTemplatePullForRelease(
  release: ParsedBaseTemplateRelease,
  state: WorkspaceTemplateState | null
): BaseTemplateReleasePull | null {
  if (!state) return null;
  const releaseUrl = normalizeTemplateGitUrl(release.baseTemplate.url);
  const installed = state.nodes.find(
    (node) => normalizeTemplateGitUrl(node.pin.url) === releaseUrl
  );
  if (!installed || samePin(installed.pin, release.baseTemplate)) return null;
  const digest = sha256HexSyncText(
    canonicalJson({ protocol: "host-base-template-release-v1", pin: release.baseTemplate })
  ).slice(0, 32);
  return {
    commandId: `host-base-template-release:${digest}`,
    alias: installed.alias,
    pin: release.baseTemplate,
  };
}

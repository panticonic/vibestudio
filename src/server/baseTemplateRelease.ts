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

export interface BaseTemplateReleasePullCoordinator {
  stop(): void;
}

export interface BaseTemplateReleasePullCoordinatorOptions {
  attempt(): Promise<void>;
  reportFailure(error: unknown, retryInMs: number): void;
  reportReady(): void;
  retryDelaysMs?: readonly number[];
  schedule?(callback: () => void, delayMs: number): () => void;
}

const DEFAULT_RELEASE_PULL_RETRY_DELAYS_MS = [5_000, 15_000, 60_000] as const;

/**
 * Process-local retry only until Composer has recorded the canonical durable
 * operation. This is lifecycle reliability, not a second migration queue.
 */
export function startBaseTemplateReleasePullCoordinator(
  options: BaseTemplateReleasePullCoordinatorOptions
): BaseTemplateReleasePullCoordinator {
  const delays = options.retryDelaysMs?.length
    ? [...options.retryDelaysMs]
    : [...DEFAULT_RELEASE_PULL_RETRY_DELAYS_MS];
  const schedule =
    options.schedule ??
    ((callback: () => void, delayMs: number) => {
      const timer = setTimeout(callback, delayMs);
      timer.unref();
      return () => clearTimeout(timer);
    });
  let stopped = false;
  let failureCount = 0;
  let cancelScheduled: (() => void) | null = null;

  const run = async (): Promise<void> => {
    if (stopped) return;
    cancelScheduled = null;
    try {
      await options.attempt();
      if (stopped) return;
      failureCount = 0;
      options.reportReady();
    } catch (error) {
      if (stopped) return;
      const retryInMs = delays[Math.min(failureCount, delays.length - 1)]!;
      failureCount += 1;
      options.reportFailure(error, retryInMs);
      cancelScheduled = schedule(() => void run(), retryInMs);
    }
  };

  void run();
  return {
    stop() {
      stopped = true;
      cancelScheduled?.();
      cancelScheduled = null;
    },
  };
}

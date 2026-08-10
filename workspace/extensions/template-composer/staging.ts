import { Buffer } from "node:buffer";
import YAML from "yaml";
import { sha256HexSyncText } from "@vibestudio/content-addressing";
import type {
  VcsReadFileResult,
  VcsResolveRepositoryResult,
  VcsStateNodeRef,
  VcsStatusResult,
} from "@vibestudio/service-schemas/vcs";
import type { WorkspaceTemplatePin } from "@vibestudio/workspace-contracts/types";
import type { TemplateAuthoringInspection } from "@vibestudio/service-schemas/templates";
import { assertTemplateLockIntegrityForRead } from "@vibestudio/workspace/templateLock";
import { composeWorkspaceConfig } from "@vibestudio/workspace/configComposition";
import { normalizeTemplateGitUrl } from "@vibestudio/workspace/templateCoordinates";
import type {
  TemplateCompositionPlan,
  TemplateOperationInspection,
  TemplateOperationPorts,
  TemplateRepositoryContribution,
} from "@workspace/template-composer";
import type { ExtensionContextLike } from "./context.js";
import { acquireTemplateSnapshot } from "./source.js";
import { semanticRepositoryDigest } from "./semanticRepository.js";
import {
  LOCK_PATH,
  COMPOSITION_SOURCE_PATH,
  META_REPOSITORY,
  TOP_CONFIG_PATH,
  type SemanticWorkspaceObservation,
} from "./workspace.js";

export interface TemplateReviewItem {
  repoPath: string;
  deltaId: string;
}

export class TemplateReviewRequired extends Error {
  constructor(
    readonly contextId: string,
    readonly items: readonly TemplateReviewItem[],
    readonly deltaBasis: VcsStateNodeRef
  ) {
    super(`Template changes require review in ${contextId}`);
    this.name = "TemplateReviewRequired";
  }
}

export class TemplateOperationMainAdvanced extends Error {
  constructor(
    readonly contextId: string,
    readonly mainEventId: string,
    readonly relation: "behind" | "diverged"
  ) {
    super(
      `Protected main advanced while template operation ${contextId} was in progress; merge event ${mainEventId} into that context and resume`
    );
    this.name = "TemplateOperationMainAdvanced";
  }
}

export const OPERATION_CONTEXT_PREFIX = "template-composer-operation-";
const OPERATION_CONTEXT_DIGEST_LENGTH = 32;
const OPERATION_RECORD_DIR = "template-operations";
const OPERATION_MESSAGE_PREFIX = "template-composer-intent:v1:";
const CANCELLATION_RECORD_DIR = "template-cancellations";

export interface TemplateOperationRecord {
  version: 1;
  operationId: string;
  kind: TemplateOperationInspection["kind"] | "publish-authoring";
  fingerprint: string;
  intent: unknown;
  pins: WorkspaceTemplatePin[];
  affectedParts: string[];
  authoringInspection?: TemplateAuthoringInspection;
  authoringPublication?: import("@vibestudio/service-schemas/templates").TemplatePublication;
  reviews?: TemplateReviewItem[];
  deltaBasis?: VcsStateNodeRef;
  preparedAffectedRepoPaths?: string[];
  buildFailures?: Array<{ unit: string; message: string }>;
  mainAdvanceEventId?: string;
}

export function affectedRepositoryPaths(
  merged: readonly string[],
  metadataAffected: readonly string[] = []
): string[] {
  return [...new Set([...merged, ...metadataAffected])].sort();
}

function operationContextId(operationId: string): string {
  return `${OPERATION_CONTEXT_PREFIX}${sha256HexSyncText(operationId).slice(
    0,
    OPERATION_CONTEXT_DIGEST_LENGTH
  )}`;
}

function operationRecordPath(): string {
  return `${OPERATION_RECORD_DIR}/record.json`;
}

function cancellationRecordPath(operationId: string): string {
  return `${CANCELLATION_RECORD_DIR}/${sha256HexSyncText(operationId)}.json`;
}

function text(file: NonNullable<VcsReadFileResult>): string {
  return file.content.kind === "text"
    ? file.content.text
    : Buffer.from(file.content.base64, "base64").toString("utf8");
}

async function status(ctx: ExtensionContextLike, contextId: string): Promise<VcsStatusResult> {
  return ctx.rpc.call("main", "vcs.status", { contextId });
}

async function resolveRepository(
  ctx: ExtensionContextLike,
  state: VcsStateNodeRef,
  repoPath: string
): Promise<VcsResolveRepositoryResult> {
  return ctx.rpc.call("main", "vcs.resolveRepository", { state, repoPath });
}

function parseOperationMessage(message: unknown): TemplateOperationRecord | null {
  if (typeof message !== "string" || !message.startsWith(OPERATION_MESSAGE_PREFIX)) return null;
  try {
    return JSON.parse(
      Buffer.from(message.slice(OPERATION_MESSAGE_PREFIX.length), "base64url").toString("utf8")
    ) as TemplateOperationRecord;
  } catch {
    return null;
  }
}

export async function ensureTemplateOperationContext(
  ctx: ExtensionContextLike,
  operationId: string
): Promise<string> {
  const contextId = operationContextId(operationId);
  await ctx.rpc.call("main", "runtime.createContext", { contextId });
  return contextId;
}

export async function readTemplateOperationRecord(
  ctx: ExtensionContextLike,
  operationId: string
): Promise<TemplateOperationRecord | null> {
  const contextId = operationContextId(operationId);
  const listed = await ctx.rpc.call<{ contexts: string[] }>("main", "runtime.listContexts", {
    prefix: contextId,
  });
  if (!listed.contexts.includes(contextId)) return null;
  const record = await readTemplateOperationRecordInContext(ctx, contextId);
  return record?.operationId === operationId ? record : null;
}

export async function readTemplateOperationRecordInContext(
  ctx: ExtensionContextLike,
  contextId: string
): Promise<TemplateOperationRecord | null> {
  const current = await status(ctx, contextId);
  const meta = await resolveRepository(ctx, current.workingHead, META_REPOSITORY);
  if (meta) {
    const file = await readFile(ctx, current.workingHead, meta.repositoryId, operationRecordPath());
    if (file) {
      const record = JSON.parse(text(file)) as TemplateOperationRecord;
      if (operationContextId(record.operationId) === contextId) return record;
    }
  }
  let cursor: string | undefined;
  do {
    const page = await ctx.rpc.call<{
      entries: Array<{ node: { kind: string; eventId?: string } }>;
      nextCursor: string | null;
    }>("main", "vcs.history", {
      root: current.committed,
      direction: "past",
      ...(cursor ? { cursor } : {}),
      limit: 200,
    });
    for (const entry of page.entries) {
      if (entry.node.kind !== "event" || !entry.node.eventId) continue;
      const inspected = await ctx.rpc.call<{
        node: { kind: string; value?: { message?: string | null } };
      }>("main", "vcs.inspect", {
        node: { kind: "event", eventId: entry.node.eventId },
        edgeLimit: 1,
      });
      const record = parseOperationMessage(inspected.node.value?.message);
      if (record && operationContextId(record.operationId) === contextId) return record;
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return null;
}

export async function isTemplateOperationCancelled(
  ctx: ExtensionContextLike,
  mainEventId: string,
  operationId: string
): Promise<boolean> {
  const state = { kind: "event" as const, eventId: mainEventId };
  const meta = await resolveRepository(ctx, state, META_REPOSITORY);
  if (!meta) return false;
  const file = await readFile(ctx, state, meta.repositoryId, cancellationRecordPath(operationId));
  if (!file) return false;
  try {
    const record = JSON.parse(text(file)) as { version?: unknown; operationId?: unknown };
    if (record.version !== 1 || record.operationId !== operationId) {
      throw new Error("does not match its content-addressed command identity");
    }
    return true;
  } catch (error) {
    throw new Error(
      `Template cancellation record for ${operationId} is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
}

export async function writeTemplateOperationRecord(
  ctx: ExtensionContextLike,
  record: TemplateOperationRecord
): Promise<void> {
  const contextId = await ensureTemplateOperationContext(ctx, record.operationId);
  const current = await status(ctx, contextId);
  if (!current.clean) {
    throw new Error(`Template operation ${record.operationId} has uncommitted work before review`);
  }
  const meta = await resolveRepository(ctx, current.workingHead, META_REPOSITORY);
  if (!meta) throw new Error("Template operation context has no meta repository");
  const content = `${JSON.stringify(record, null, 2)}\n`;
  await ctx.rpc.call("main", "vcs.edit", {
    commandId: `${contextId}:record-intent`,
    contextId,
    expectedWorkingHead: current.workingHead,
    intentSummary: "Record the approved exact template operation intent",
    changes: [
      {
        kind: "file-create",
        repositoryId: meta.repositoryId,
        path: operationRecordPath(),
        content: { kind: "text", text: content },
        mode: 0o644,
      },
    ],
  });
  const edited = await status(ctx, contextId);
  const encoded = Buffer.from(JSON.stringify(record), "utf8").toString("base64url");
  await ctx.rpc.call("main", "vcs.commit", {
    commandId: `${contextId}:commit-intent`,
    contextId,
    expectedWorkingHead: edited.workingHead,
    intentSummary: "Commit the approved exact template operation intent",
    message: `${OPERATION_MESSAGE_PREFIX}${encoded}`,
  });
}

export async function updateTemplateOperationRecord(
  ctx: ExtensionContextLike,
  record: TemplateOperationRecord
): Promise<void> {
  const contextId = await ensureTemplateOperationContext(ctx, record.operationId);
  let current = await status(ctx, contextId);
  if (!current.clean) {
    throw new Error(`Cannot update template operation ${record.operationId} with pending work`);
  }
  const meta = await resolveRepository(ctx, current.workingHead, META_REPOSITORY);
  if (!meta) throw new Error("Template operation context has no meta repository");
  const file = await readFile(ctx, current.workingHead, meta.repositoryId, operationRecordPath());
  const content = `${JSON.stringify(record, null, 2)}\n`;
  if (file && text(file) === content) return;
  const recordDigest = sha256HexSyncText(JSON.stringify(record)).slice(0, 16);
  await ctx.rpc.call("main", "vcs.edit", {
    commandId: `${contextId}:update-record:${recordDigest}`,
    contextId,
    expectedWorkingHead: current.workingHead,
    intentSummary: "Record resumable template operation state",
    changes: file
      ? [
          {
            kind: "text-edit",
            repositoryId: meta.repositoryId,
            fileId: file.fileId,
            edits: [{ start: 0, end: text(file).length, text: content }],
          },
        ]
      : [
          {
            kind: "file-create",
            repositoryId: meta.repositoryId,
            path: operationRecordPath(),
            content: { kind: "text", text: content },
            mode: 0o644,
          },
        ],
  });
  current = await status(ctx, contextId);
  await ctx.rpc.call("main", "vcs.commit", {
    commandId: `${contextId}:commit-record:${recordDigest}`,
    contextId,
    expectedWorkingHead: current.workingHead,
    intentSummary: "Commit resumable template VCS review handles",
    message: `${OPERATION_MESSAGE_PREFIX}${Buffer.from(JSON.stringify(record), "utf8").toString(
      "base64url"
    )}`,
  });
}

/** Remove context-local recovery state before publishing the composed result.
 * The exact resumable record is retained in the clearing commit's attribution
 * so an interrupted approval-gated push never strands the prepared context. */
export async function clearTemplateOperationRecordFile(
  ctx: ExtensionContextLike,
  record: TemplateOperationRecord
): Promise<void> {
  const operationId = record.operationId;
  const contextId = await ensureTemplateOperationContext(ctx, operationId);
  let current = await status(ctx, contextId);
  if (!current.clean) {
    throw new Error(`Cannot finalize template operation ${operationId} with pending work`);
  }
  const meta = await resolveRepository(ctx, current.workingHead, META_REPOSITORY);
  if (!meta) throw new Error("Template operation context has no meta repository");
  const file = await readFile(ctx, current.workingHead, meta.repositoryId, operationRecordPath());
  if (!file) return;
  const clearDigest = sha256HexSyncText(
    JSON.stringify({ workingHead: current.workingHead, fileId: file.fileId })
  ).slice(0, 16);
  await ctx.rpc.call("main", "vcs.edit", {
    commandId: `${contextId}:clear-operation-record:${clearDigest}`,
    contextId,
    expectedWorkingHead: current.workingHead,
    intentSummary: "Remove context-local template recovery state before publication",
    changes: [{ kind: "file-delete", repositoryId: meta.repositoryId, fileId: file.fileId }],
  });
  current = await status(ctx, contextId);
  await ctx.rpc.call("main", "vcs.commit", {
    commandId: `${contextId}:commit-clear-operation-record:${clearDigest}`,
    contextId,
    expectedWorkingHead: current.workingHead,
    intentSummary: "Finalize repaired template operation",
    message: `${OPERATION_MESSAGE_PREFIX}${Buffer.from(JSON.stringify(record), "utf8").toString(
      "base64url"
    )}`,
  });
}

async function readFile(
  ctx: ExtensionContextLike,
  state: VcsStateNodeRef,
  repositoryId: string,
  filePath: string
): Promise<VcsReadFileResult> {
  return ctx.rpc.call("main", "vcs.readFile", {
    state,
    repositoryId,
    file: { kind: "path", path: filePath },
  });
}

function pinForContribution(plan: TemplateCompositionPlan, nodeId: string): WorkspaceTemplatePin {
  const node = plan.nodes.find((candidate) => candidate.nodeId === nodeId);
  if (!node) throw new Error(`Template plan is missing node ${nodeId}`);
  return node.pin;
}

async function alreadyStaged(
  ctx: ExtensionContextLike,
  contextId: string,
  fingerprint: string
): Promise<boolean> {
  const current = await status(ctx, contextId);
  const meta = await resolveRepository(ctx, current.workingHead, META_REPOSITORY);
  if (!meta) return false;
  const lock = await readFile(ctx, current.workingHead, meta.repositoryId, LOCK_PATH);
  if (!lock) return false;
  try {
    return (
      assertTemplateLockIntegrityForRead(YAML.parse(text(lock)) as unknown).fingerprint ===
      fingerprint
    );
  } catch {
    return false;
  }
}

function subtreeFiles(
  files: readonly {
    path: string;
    contentHash: string;
    size: number;
    mode: 0o644 | 0o755;
  }[],
  repoPath: string
) {
  const prefix = `${repoPath}/`;
  return files
    .filter((file) => file.path.startsWith(prefix))
    .map((file) => ({ ...file, path: file.path.slice(prefix.length) }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

interface ContributionSide {
  nodeId: string;
  alias: string;
  pin: WorkspaceTemplatePin;
  subtreeDigest: `v1-sha256:${string}`;
  subdir: string;
  files: Array<{ path: string; contentHash: string; mode: 0o644 | 0o755 }>;
}

function emptyContributionSource(nodeId: string, repoPath: string) {
  return {
    kind: "generated" as const,
    uri: `vibestudio-template://empty/${nodeId}/${encodeURIComponent(repoPath)}`,
    snapshotRevision: "empty",
    snapshot: semanticRepositoryDigest([]),
  };
}

function gitContributionSource(side: ContributionSide) {
  return {
    kind: "git" as const,
    url: side.pin.url,
    commit: side.pin.commit,
    subdir: side.subdir,
    snapshot: side.subtreeDigest,
  };
}

function nextContributionSides(
  plan: TemplateCompositionPlan,
  repoPath: string
): Map<string, ContributionSide> {
  return new Map(
    (plan.repositories[repoPath]?.contributions ?? []).map((contribution) => {
      const pin = pinForContribution(plan, contribution.nodeId);
      return [
        normalizeTemplateGitUrl(pin.url),
        {
          nodeId: contribution.nodeId,
          alias: contribution.alias,
          pin,
          subtreeDigest: contribution.subtreeDigest,
          subdir: contribution.subdir,
          files: contribution.files.map(({ path, contentHash, mode }) => ({
            path,
            contentHash,
            mode,
          })),
        },
      ];
    })
  );
}

async function previousContributionSides(
  ctx: ExtensionContextLike,
  statePath: string,
  previous: NonNullable<SemanticWorkspaceObservation["lock"]>,
  repoPath: string
): Promise<Map<string, ContributionSide>> {
  const result = new Map<string, ContributionSide>();
  for (const contribution of previous.repositories[repoPath]?.contributions ?? []) {
    const node = previous.nodes.find((candidate) => candidate.nodeId === contribution.nodeId);
    if (!node) {
      throw new Error(`Previous template lock is missing node ${contribution.nodeId}`);
    }
    const snapshot = await acquireTemplateSnapshot(ctx, statePath, node.pin, node.nodeId);
    const files = subtreeFiles(snapshot.files, repoPath);
    if (
      semanticRepositoryDigest(files.map((file) => ({ ...file, byteLength: file.size }))) !==
      contribution.subtreeDigest
    ) {
      throw new Error(
        `Previous template contribution ${node.alias} for ${repoPath} is inconsistent`
      );
    }
    result.set(normalizeTemplateGitUrl(node.pin.url), {
      nodeId: node.nodeId,
      alias: node.alias,
      pin: node.pin,
      subtreeDigest: contribution.subtreeDigest,
      subdir: repoPath,
      files: files.map(({ path, contentHash, mode }) => ({ path, contentHash, mode })),
    });
  }
  return result;
}

export async function mergeTemplateContributions(
  ctx: ExtensionContextLike,
  statePath: string,
  contextId: string,
  plan: TemplateCompositionPlan,
  previous: SemanticWorkspaceObservation["lock"],
  record?: TemplateOperationRecord
): Promise<string[]> {
  const items: TemplateReviewItem[] = [];
  const changed: string[] = [];
  const completedDeltas: Array<{ repoPath: string; deltaId: string }> = [];
  const registeredDeltas: Array<{ repoPath: string; deltaId: string }> = [];
  let deltaBasis = record?.deltaBasis;
  const repoPaths = [
    ...new Set([...Object.keys(previous?.repositories ?? {}), ...Object.keys(plan.repositories)]),
  ].sort();
  for (const repoPath of repoPaths) {
    const current = await status(ctx, contextId);
    let repository = await resolveRepository(ctx, current.workingHead, repoPath);
    const next = nextContributionSides(plan, repoPath);
    const prior = previous
      ? await previousContributionSides(ctx, statePath, previous, repoPath)
      : new Map<string, ContributionSide>();

    if (!repository && next.size > 0) {
      const seed = [...next.entries()].find(([, contribution]) => contribution.files.length > 0);
      if (seed) {
        const [url, first] = seed;
        await ctx.rpc.call("main", "vcs.importSnapshot", {
          commandId: `${contextId}:import:${repoPath}`,
          contextId,
          expectedWorkingHead: current.workingHead,
          intentSummary: `Import ${repoPath} contribution from ${first.alias}`,
          source: gitContributionSource(first),
          repositories: [{ repoPath, files: first.files }],
          message: `Import ${repoPath} contribution from ${first.alias}`,
        });
        next.delete(url);
        // The imported snapshot is already the complete next side for this
        // contribution. Do not subsequently apply its old→new delta to itself.
        prior.delete(url);
        changed.push(repoPath);
        const imported = await status(ctx, contextId);
        repository = await resolveRepository(ctx, imported.workingHead, repoPath);
      }
    }
    if (!repository) continue;
    const urls = [...new Set([...prior.keys(), ...next.keys()])].sort();
    for (const url of urls) {
      const oldSide = prior.get(url);
      const newSide = next.get(url);
      if (
        oldSide &&
        newSide &&
        oldSide.pin.commit === newSide.pin.commit &&
        oldSide.subtreeDigest === newSide.subtreeDigest
      ) {
        continue;
      }
      const identity = oldSide?.nodeId ?? newSide!.nodeId;
      const action = oldSide && newSide ? "Update" : newSide ? "Add" : "Remove";
      const basis = await status(ctx, contextId);
      deltaBasis ??= basis.committed;
      const delta = await ctx.rpc.call<{ deltaId: string }>("main", "vcs.registerExternalDelta", {
        commandId: `${contextId}:delta:${repoPath}:${identity}`,
        contextId,
        expectedWorkingHead: deltaBasis,
        intentSummary: `${action} ${repoPath} contribution from ${newSide?.alias ?? oldSide!.alias}`,
        repositoryId: repository.repositoryId,
        repoPath,
        oldSource: oldSide
          ? gitContributionSource(oldSide)
          : emptyContributionSource(identity, repoPath),
        newSource: newSide
          ? gitContributionSource(newSide)
          : emptyContributionSource(identity, repoPath),
        oldFiles: oldSide?.files ?? [],
        newFiles: newSide?.files ?? [],
      });
      registeredDeltas.push({ repoPath, deltaId: delta.deltaId });
    }
  }
  for (const { repoPath, deltaId } of registeredDeltas) {
    const latest = await status(ctx, contextId);
    const compared = await ctx.rpc.call<{
      resolution: { complete: boolean; concluded: boolean };
    }>("main", "vcs.compare", {
      target: latest.workingHead,
      source: { kind: "external-delta", deltaId },
      limit: 1,
    });
    if (compared.resolution.complete && !compared.resolution.concluded) {
      await ctx.rpc.call("main", "vcs.merge", {
        commandId: `${contextId}:conclude-convergent:${deltaId}`,
        contextId,
        expectedWorkingHead: latest.workingHead,
        source: { kind: "external-delta", deltaId },
        intentSummary: "Conclude a convergent template update so its source remains in ancestry",
      });
    }
    if (!compared.resolution.complete) {
      items.push({ repoPath, deltaId });
      continue;
    }
    completedDeltas.push({ repoPath, deltaId });
    changed.push(repoPath);
  }
  let current = await status(ctx, contextId);
  if (!current.clean) {
    await ctx.rpc.call("main", "vcs.commit", {
      commandId: `${contextId}:commit-reviewed-deltas`,
      contextId,
      expectedWorkingHead: current.workingHead,
      intentSummary: "Commit reviewed template repository updates",
      message: "Apply reviewed template repository updates",
    });
  }
  for (const completed of completedDeltas) {
    current = await status(ctx, contextId);
    await ctx.rpc.call("main", "vcs.finalizeExternalDelta", {
      commandId: `${contextId}:finalize:${completed.deltaId}`,
      contextId,
      expectedWorkingHead: current.workingHead,
      intentSummary: `Finalize reviewed template update for ${completed.repoPath}`,
      deltaId: completed.deltaId,
    });
  }
  if (items.length > 0) {
    throw new TemplateReviewRequired(contextId, items, deltaBasis!);
  }
  return [...new Set(changed)].sort();
}

function nextWorkspaceSource(
  observation: SemanticWorkspaceObservation,
  inspection: TemplateOperationInspection
): SemanticWorkspaceObservation["top"] {
  const registry = observation.top.templates?.registry;
  const relationships = inspection.nextTemplates;
  const templates = {
    use: relationships?.use ?? [],
    ...(relationships?.overrides && Object.keys(relationships.overrides).length > 0
      ? { overrides: relationships.overrides }
      : {}),
    ...(registry ? { registry } : {}),
    ...((relationships?.bootstrapAdopted ?? observation.top.templates?.bootstrapAdopted)
      ? {
          bootstrapAdopted:
            relationships?.bootstrapAdopted ?? observation.top.templates?.bootstrapAdopted,
        }
      : {}),
    ...((relationships?.suggestionDecisions ?? observation.top.templates?.suggestionDecisions)
      ? {
          suggestionDecisions:
            relationships?.suggestionDecisions ?? observation.top.templates?.suggestionDecisions,
        }
      : {}),
  };
  return { ...observation.top, templates };
}

function flattenedRuntimeYaml(
  observation: SemanticWorkspaceObservation,
  inspection: TemplateOperationInspection,
  source: SemanticWorkspaceObservation["top"]
): string {
  const ancestors = new Map<string, Set<string>>();
  const layers = inspection.plan.nodes.map((node) => {
    const inherited = new Set<string>();
    for (const parent of node.parents) {
      inherited.add(parent);
      for (const ancestor of ancestors.get(parent) ?? []) inherited.add(ancestor);
    }
    ancestors.set(node.nodeId, inherited);
    return {
      nodeId: node.nodeId,
      alias: node.alias,
      ancestors: [...inherited],
      config: node.fragment,
    };
  });
  const { id: _id, ...runtime } = composeWorkspaceConfig(source, layers, observation.workspaceId);
  return YAML.stringify(runtime, { lineWidth: 0 });
}

async function stageMeta(
  ctx: ExtensionContextLike,
  contextId: string,
  observation: SemanticWorkspaceObservation,
  inspection: TemplateOperationInspection
): Promise<void> {
  let current = await status(ctx, contextId);
  if (!current.clean) {
    await ctx.rpc.call("main", "vcs.discard", {
      commandId: `${contextId}:discard-incomplete`,
      contextId,
      expectedWorkingHead: current.workingHead,
      intentSummary: "Discard an incomplete template metadata staging attempt",
    });
    current = await status(ctx, contextId);
  }
  const meta = await resolveRepository(ctx, current.workingHead, META_REPOSITORY);
  if (!meta) throw new Error("Template composition requires the meta repository");
  const desired = new Map<string, string>();
  const source = nextWorkspaceSource(observation, inspection);
  desired.set(COMPOSITION_SOURCE_PATH, YAML.stringify(source, { lineWidth: 0 }));
  desired.set(TOP_CONFIG_PATH, flattenedRuntimeYaml(observation, inspection, source));
  for (const artifact of inspection.plan.artifacts) {
    if (!artifact.path.startsWith("meta/")) {
      throw new Error(`Generated template artifact is outside meta: ${artifact.path}`);
    }
    desired.set(
      artifact.path.slice("meta/".length),
      new TextDecoder("utf8", { fatal: true }).decode(artifact.bytes)
    );
  }
  const removals = new Set(
    inspection.plan.removedArtifactPaths.map((artifactPath) =>
      artifactPath.startsWith("meta/") ? artifactPath.slice("meta/".length) : artifactPath
    )
  );
  if (inspection.plan.lock === null) removals.add(LOCK_PATH);
  removals.add(operationRecordPath());
  const changes: unknown[] = [];
  for (const [filePath, desiredText] of desired) {
    const existing = await readFile(ctx, current.workingHead, meta.repositoryId, filePath);
    if (!existing) {
      changes.push({
        kind: "file-create",
        repositoryId: meta.repositoryId,
        path: filePath,
        content: { kind: "text", text: desiredText },
        mode: 0o644,
      });
    } else if (text(existing) !== desiredText) {
      changes.push({
        kind: "text-edit",
        repositoryId: meta.repositoryId,
        fileId: existing.fileId,
        edits: [{ start: 0, end: text(existing).length, text: desiredText }],
      });
    }
  }
  for (const filePath of removals) {
    if (desired.has(filePath)) continue;
    const existing = await readFile(ctx, current.workingHead, meta.repositoryId, filePath);
    if (existing) {
      changes.push({
        kind: "file-delete",
        repositoryId: meta.repositoryId,
        fileId: existing.fileId,
      });
    }
  }
  for (let offset = 0; offset < changes.length; offset += 200) {
    current = await status(ctx, contextId);
    await ctx.rpc.call("main", "vcs.edit", {
      commandId: `${contextId}:meta:${offset / 200}`,
      contextId,
      expectedWorkingHead: current.workingHead,
      intentSummary: "Update generated template composition metadata",
      changes: changes.slice(offset, offset + 200),
    });
  }
  current = await status(ctx, contextId);
  if (current.clean) return;
  await ctx.rpc.call("main", "vcs.commit", {
    commandId: `${contextId}:commit`,
    contextId,
    expectedWorkingHead: current.workingHead,
    intentSummary: "Commit the reviewed template composition",
    message: `Compose templates ${inspection.plan.fingerprint}`,
  });
}

export function createTemplateOperationPorts(
  ctx: ExtensionContextLike,
  statePath: string,
  observation: SemanticWorkspaceObservation,
  buildAffected: TemplateOperationPorts["buildAffected"],
  record?: TemplateOperationRecord
): TemplateOperationPorts {
  return {
    async openContext(operationId) {
      const contextId = operationContextId(operationId);
      await ctx.rpc.call("main", "runtime.createContext", { contextId });
      const current = await status(ctx, contextId);
      if (current.mainRelation === "behind" || current.mainRelation === "diverged") {
        throw new TemplateOperationMainAdvanced(
          contextId,
          current.mainEventId,
          current.mainRelation
        );
      }
      return { contextId };
    },
    async stageComposition(contextId, inspection) {
      if (await alreadyStaged(ctx, contextId, inspection.plan.fingerprint)) {
        return {
          affectedRepoPaths: [
            ...new Set([
              ...Object.keys(observation.lock?.repositories ?? {}),
              ...Object.keys(inspection.plan.repositories),
            ]),
          ].sort(),
        };
      }
      // Lineage adoption deliberately establishes the contribution baseline
      // without replaying it into the current workspace. The present source is
      // the local descendant; future pull/remove operations use the adopted
      // contribution as their ordinary external-delta base.
      const merged =
        inspection.kind === "adopt"
          ? Object.keys(inspection.plan.repositories).sort()
          : await mergeTemplateContributions(
              ctx,
              statePath,
              contextId,
              inspection.plan,
              observation.lock,
              record
            );
      await stageMeta(ctx, contextId, observation, inspection);
      return {
        affectedRepoPaths: affectedRepositoryPaths(merged),
      };
    },
    buildAffected,
    async publish(contextId, expectedMainEventId) {
      const current = await status(ctx, contextId);
      if (current.mainRelation === "behind" || current.mainRelation === "diverged") {
        throw new TemplateOperationMainAdvanced(
          contextId,
          current.mainEventId,
          current.mainRelation
        );
      }
      if (!current.clean || current.committed.kind !== "event") {
        throw new Error(`Template operation context ${contextId} is not committed`);
      }
      const result = await ctx.rpc.call<{ mainEventId: string }>("main", "vcs.push", {
        commandId: `${contextId}:publish`,
        contextId,
        expectedCommittedEventId: current.committed.eventId,
        expectedMainEventId,
      });
      return { mainEventId: result.mainEventId };
    },
    async discard(contextId) {
      await ctx.rpc.call("main", "runtime.destroyContext", { contextId, recursive: false });
    },
  };
}

export async function publishTemplateSuggestionTopLayer(
  ctx: ExtensionContextLike,
  operationId: string,
  observation: SemanticWorkspaceObservation,
  top: SemanticWorkspaceObservation["top"],
  inspection: TemplateOperationInspection
): Promise<string> {
  const contextId = await ensureTemplateOperationContext(ctx, operationId);
  let current = await status(ctx, contextId);
  if (current.mainRelation !== "at") {
    throw new Error(`Template suggestion ${operationId} was based on a different protected main`);
  }
  await stageMeta(ctx, contextId, { ...observation, top }, inspection);
  current = await status(ctx, contextId);
  const result = await ctx.rpc.call<{ mainEventId: string }>("main", "vcs.push", {
    commandId: `${contextId}:publish-suggestion`,
    contextId,
    expectedCommittedEventId: current.committed.eventId,
    expectedMainEventId: observation.mainEventId,
  });
  return result.mainEventId;
}

/**
 * Win cancellation through the same protected-main compare-and-swap used by
 * publication. If an operation publishes concurrently, exactly one push can
 * advance the expected main event; cancellation never destroys a context until
 * this durable tombstone has won.
 */
export async function publishTemplateOperationCancellation(
  ctx: ExtensionContextLike,
  operationId: string,
  expectedMainEventId: string
): Promise<string> {
  const contextId = `template-composer-cancellation-${sha256HexSyncText(
    `${operationId}\0${expectedMainEventId}`
  ).slice(0, OPERATION_CONTEXT_DIGEST_LENGTH)}`;
  const markerPath = cancellationRecordPath(operationId);
  await ctx.rpc.call("main", "runtime.createContext", { contextId });
  let current = await status(ctx, contextId);
  if (current.mainRelation !== "at" || current.mainEventId !== expectedMainEventId) {
    throw new Error(
      `Protected main changed before template operation ${operationId} could be cancelled`
    );
  }
  const meta = await resolveRepository(ctx, current.workingHead, META_REPOSITORY);
  if (!meta) throw new Error("Template operation cancellation requires the meta repository");
  if (await readFile(ctx, current.workingHead, meta.repositoryId, markerPath)) {
    return current.mainEventId;
  }
  await ctx.rpc.call("main", "vcs.edit", {
    commandId: `${contextId}:record`,
    contextId,
    expectedWorkingHead: current.workingHead,
    intentSummary: `Cancel template operation ${operationId}`,
    changes: [
      {
        kind: "file-create",
        repositoryId: meta.repositoryId,
        path: markerPath,
        content: {
          kind: "text",
          text: `${JSON.stringify({ version: 1, operationId }, null, 2)}\n`,
        },
        mode: 0o644,
      },
    ],
  });
  current = await status(ctx, contextId);
  await ctx.rpc.call("main", "vcs.commit", {
    commandId: `${contextId}:commit`,
    contextId,
    expectedWorkingHead: current.workingHead,
    intentSummary: `Commit cancellation of template operation ${operationId}`,
    message: `Cancel template operation ${operationId}`,
  });
  current = await status(ctx, contextId);
  if (!current.clean || current.committed.kind !== "event") {
    throw new Error(`Template cancellation context ${contextId} is not committed`);
  }
  const result = await ctx.rpc.call<{ mainEventId: string }>("main", "vcs.push", {
    commandId: `${contextId}:publish`,
    contextId,
    expectedCommittedEventId: current.committed.eventId,
    expectedMainEventId,
  });
  return result.mainEventId;
}

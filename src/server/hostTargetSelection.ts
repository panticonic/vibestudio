import * as fs from "node:fs";
import * as path from "node:path";
import type {
  HostTarget,
  HostTargetCandidate,
  HostTargetSelection,
  HostTargetSelectionInput,
} from "@vibestudio/shared/hostTargets";
import { normalizeUnitRepoPath as normalizeRepoPath } from "@vibestudio/unit-host";
import { stateLayout } from "./stateLayout.js";
import {
  publishExecutionOwner,
  type ExecutionPublicationPort,
} from "@vibestudio/shared/execution/retention";

interface HostTargetSelectionState {
  selections?: HostTargetSelection[];
}

export interface HostTargetSelectionStore {
  list(): HostTargetSelection[];
  replace(selection: HostTargetSelection): void;
  clear(workspaceId: string, target: HostTarget): void;
}

/**
 * Durable storage for explicit host-target choices. Default selections are
 * deliberately derived from current declarations and candidates, never saved.
 */
export class FileHostTargetSelectionStore implements HostTargetSelectionStore {
  private readonly filePath: string;

  constructor(
    statePath: string,
    private readonly publication?: {
      port: ExecutionPublicationPort;
      executionDigestForBuild(buildKey: string): string | null;
    }
  ) {
    this.filePath = stateLayout(statePath).hostTargetSelectionsFile;
  }

  list(): HostTargetSelection[] {
    if (!fs.existsSync(this.filePath)) return [];
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as HostTargetSelectionState;
      return Array.isArray(parsed.selections)
        ? parsed.selections.filter(isHostTargetSelection)
        : [];
    } catch (error) {
      console.warn(
        `[HostTargetSelection] Failed to read selections: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return [];
    }
  }

  replace(selection: HostTargetSelection): void {
    const selections = this.list().filter(
      (candidate) =>
        !(candidate.workspaceId === selection.workspaceId && candidate.target === selection.target)
    );
    selections.push(selection);
    const buildKey = selection.buildKey;
    const executionDigest =
      buildKey && this.publication ? this.publication.executionDigestForBuild(buildKey) : null;
    if (buildKey && this.publication && !executionDigest) {
      throw new Error(`Host target selection references unverifiable build ${buildKey}`);
    }
    publishExecutionOwner(
      this.publication?.port,
      {
        owner: "host-target-selection",
        ownerId: `${selection.workspaceId}:${selection.target}`,
        artifacts: buildKey && executionDigest ? [{ buildKey, executionDigest }] : [],
      },
      () => this.write(selections)
    );
  }

  clear(workspaceId: string, target: HostTarget): void {
    this.write(
      this.list().filter(
        (selection) => !(selection.workspaceId === workspaceId && selection.target === target)
      )
    );
  }

  private write(selections: HostTargetSelection[]): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmpPath, JSON.stringify({ selections }, null, 2), "utf8");
    fs.renameSync(tmpPath, this.filePath);
  }
}

export interface HostTargetVersionList {
  current: { activeBundleKey: string } | null;
  previous: Array<{ activeBundleKey: string }>;
}

export interface HostTargetAppEntry {
  name: string;
  target: HostTarget;
  source: { repo: string };
  status: string;
  activeBundleKey: string | null;
}

export interface HostTargetSelectionPolicyDeps {
  workspaceId: string;
  store: HostTargetSelectionStore;
  listCandidates(target: HostTarget): HostTargetCandidate[];
  listVersions(appId: string): HostTargetVersionList;
  listEntries(): HostTargetAppEntry[];
  declaredSource(target: HostTarget): string | null;
}

export interface HostTargetSelectionResult {
  selection: HostTargetSelection | null;
  valid: boolean;
  reason?: string;
}

/**
 * The single policy owner for choosing a workspace app for each host surface.
 * AppHost supplies live build/registry projections; this collaborator owns
 * persistence, validation, deterministic defaults, and pin matching.
 */
export class HostTargetSelectionPolicy {
  constructor(private readonly deps: HostTargetSelectionPolicyDeps) {}

  /** Durable explicit selections only; derived defaults do not retain artifacts. */
  listPersisted(): HostTargetSelection[] {
    return this.deps.store
      .list()
      .filter((selection) => selection.workspaceId === this.deps.workspaceId);
  }

  get(target: HostTarget): HostTargetSelectionResult {
    const explicitSelection = this.listPersisted().find((candidate) => candidate.target === target);
    const selection = explicitSelection ?? this.defaultSelection(target);
    if (!selection) return { selection: null, valid: false, reason: "No app selected" };

    const candidate = this.deps
      .listCandidates(target)
      .find((item) => item.name === selection.appId || item.source === selection.source);
    if (!candidate) {
      return { selection, valid: false, reason: "Selected app is no longer available" };
    }
    if (!candidate.compatibility.selectable) {
      return {
        selection,
        valid: false,
        reason: candidate.compatibility.reasons.join("; ") || "Selected app is not compatible",
      };
    }
    if (
      (selection.mode === "pinned-build" || selection.mode === "pinned-ref") &&
      !this.isRetainedBuild(selection.appId, selection.buildKey)
    ) {
      return { selection, valid: false, reason: "Selected build is no longer retained" };
    }
    return { selection, valid: true };
  }

  set(target: HostTarget, input: HostTargetSelectionInput): HostTargetSelection {
    const normalizedInputSource = normalizeRepoPath(input.source);
    const candidate = this.deps
      .listCandidates(target)
      .find((item) => item.name === input.source || item.source === normalizedInputSource);
    if (!candidate) throw new Error(`No ${target} app candidate found for ${input.source}`);
    if (!candidate.compatibility.selectable) {
      throw new Error(
        `App ${candidate.name} cannot be selected for ${target}: ${candidate.compatibility.reasons.join("; ")}`
      );
    }

    const mode = input.mode ?? "follow-ref";
    if (mode === "pinned-build" || mode === "pinned-ref") {
      if (!input.buildKey) throw new Error(`${mode} selections require buildKey`);
      if (!this.isRetainedBuild(candidate.name, input.buildKey)) {
        throw new Error(`Build ${input.buildKey} is not retained for ${candidate.name}`);
      }
    }
    if (mode === "pinned-ref" && !input.ref) {
      throw new Error("pinned-ref selections require ref");
    }

    const selection: HostTargetSelection = {
      workspaceId: this.deps.workspaceId,
      target,
      source: candidate.source,
      appId: candidate.name,
      mode,
      ref: input.ref,
      buildKey: input.buildKey,
      updatedAt: Date.now(),
      autoSelected: input.autoSelected,
    };
    this.deps.store.replace(selection);
    return selection;
  }

  clear(target: HostTarget): void {
    this.deps.store.clear(this.deps.workspaceId, target);
  }

  selectedSource(target: HostTarget): string | null {
    const current = this.get(target);
    if (current.valid && current.selection) return current.selection.source;

    const preferred = this.normalizedDeclaredSource(target);
    const activeEntries = this.deps
      .listEntries()
      .filter(
        (entry) =>
          entry.target === target &&
          isActiveForTarget(target, entry.status) &&
          !!entry.activeBundleKey
      );
    const preferredActive = preferred
      ? activeEntries.find((entry) => normalizeRepoPath(entry.source.repo) === preferred)
      : undefined;
    if (preferredActive) return normalizeRepoPath(preferredActive.source.repo);
    const onlyActiveEntry = activeEntries[0];
    if (activeEntries.length === 1 && onlyActiveEntry) {
      return normalizeRepoPath(onlyActiveEntry.source.repo);
    }

    const candidates = this.deps
      .listCandidates(target)
      .filter((candidate) => candidate.compatibility.selectable);
    const preferredCandidate = preferred
      ? candidates.find((candidate) => normalizeRepoPath(candidate.source) === preferred)
      : undefined;
    if (preferredCandidate) return preferredCandidate.source;
    const onlyCandidate = candidates[0];
    return candidates.length === 1 && onlyCandidate ? onlyCandidate.source : null;
  }

  isSelected(entry: HostTargetAppEntry): boolean | undefined {
    const current = this.get(entry.target);
    if (!current.selection) return undefined;
    return (
      normalizeRepoPath(current.selection.source) === normalizeRepoPath(entry.source.repo) ||
      current.selection.appId === entry.name
    );
  }

  pinnedFor(entry: HostTargetAppEntry): HostTargetSelection | null {
    const current = this.get(entry.target);
    const selection = current.valid ? current.selection : null;
    if (!selection) return null;
    if (selection.mode !== "pinned-build" && selection.mode !== "pinned-ref") return null;
    if (
      selection.appId !== entry.name &&
      normalizeRepoPath(selection.source) !== normalizeRepoPath(entry.source.repo)
    ) {
      return null;
    }
    return selection;
  }

  private defaultSelection(target: HostTarget): HostTargetSelection | null {
    const candidates = this.deps
      .listCandidates(target)
      .filter((candidate) => candidate.compatibility.selectable);
    const declared = candidates.filter((candidate) => candidate.declared);
    const preferredSource = this.normalizedDeclaredSource(target);
    const selected =
      (preferredSource
        ? (declared.find((candidate) => normalizeRepoPath(candidate.source) === preferredSource) ??
          candidates.find((candidate) => normalizeRepoPath(candidate.source) === preferredSource))
        : null) ??
      declared.find((candidate) => candidate.compatibility.recommended) ??
      declared[0] ??
      (candidates.length === 1 ? candidates[0] : null);
    if (!selected) return null;
    return {
      workspaceId: this.deps.workspaceId,
      target,
      source: selected.source,
      appId: selected.name,
      mode: "follow-ref",
      autoSelected: true,
      updatedAt: 0,
    };
  }

  private normalizedDeclaredSource(target: HostTarget): string | null {
    const source = this.deps.declaredSource(target);
    return source ? normalizeRepoPath(source) : null;
  }

  private isRetainedBuild(appId: string, buildKey: string | undefined): boolean {
    if (!buildKey) return false;
    const versions = this.deps.listVersions(appId);
    return [versions.current, ...versions.previous].some(
      (version) => version?.activeBundleKey === buildKey
    );
  }
}

function isActiveForTarget(target: HostTarget, status: string): boolean {
  return target === "terminal"
    ? status === "available" || status === "running"
    : status === "running";
}

function isHostTargetSelection(value: unknown): value is HostTargetSelection {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<HostTargetSelection>;
  return (
    typeof candidate.workspaceId === "string" &&
    (candidate.target === "electron" ||
      candidate.target === "react-native" ||
      candidate.target === "terminal") &&
    typeof candidate.source === "string" &&
    typeof candidate.appId === "string" &&
    (candidate.mode === "follow-ref" ||
      candidate.mode === "pinned-build" ||
      candidate.mode === "pinned-ref") &&
    typeof candidate.updatedAt === "number"
  );
}

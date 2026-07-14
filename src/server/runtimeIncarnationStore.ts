import * as fs from "node:fs";
import * as path from "node:path";
import type { Principal } from "@vibestudio/rpc";
import { canonicalJson } from "@vibestudio/shared/contentTree/canonicalJson";
import {
  domainHash,
  verifyExecutionArtifactRef,
  type AdoptionPolicy,
  type ExecutionArtifactRef,
  type ExecutionSelector,
  type Sha256,
} from "@vibestudio/shared/execution/identity";
import { stateLayout } from "./stateLayout.js";

export type RuntimeIncarnationStatus = "prepared" | "active" | "retired" | "failed";
export type RuntimeTransitionTrigger = "launch" | "source-advanced" | "manual-repin" | "rollback";
export type RuntimeTransitionStatus =
  | "preparing"
  | "awaiting-adoption"
  | "committed"
  | "failed"
  | "cancelled";

export interface RuntimeIncarnationRecord {
  incarnationId: Sha256;
  logicalEntityId: string;
  artifact: ExecutionArtifactRef;
  selectorPolicy: ExecutionSelector;
  compilationCacheKey: string;
  generation: number;
  scopeRef?: string;
  status: RuntimeIncarnationStatus;
  startedAt: number;
  endedAt: number | null;
}

export interface RuntimeUpgradeTransition {
  transitionId: Sha256;
  logicalEntityId: string;
  selector: ExecutionSelector;
  fromIncarnationId: Sha256 | null;
  toIncarnationId: Sha256;
  trigger: RuntimeTransitionTrigger;
  actor: Principal;
  adoptionPolicy: AdoptionPolicy;
  status: RuntimeTransitionStatus;
  error: { code: string; message: string; failedAt: number } | null;
  createdAt: number;
  committedAt: number | null;
}

interface RuntimeIncarnationFile {
  version: 2;
  active: Record<string, Sha256>;
  incarnations: RuntimeIncarnationRecord[];
  transitions: RuntimeUpgradeTransition[];
}

export interface PreparedRuntimeTransition {
  incarnation: RuntimeIncarnationRecord;
  transition: RuntimeUpgradeTransition;
}

/**
 * Durable append-only runtime lineage. Selectors stop at preparation: serving
 * paths read only the active incarnation's verified immutable artifact.
 */
export class RuntimeIncarnationStore {
  private readonly filePath: string;
  private state: RuntimeIncarnationFile;

  constructor(statePath: string) {
    this.filePath = stateLayout(statePath).runtimeIncarnationsFile;
    this.state = this.load();
  }

  getActive(logicalEntityId: string): RuntimeIncarnationRecord | null {
    const id = this.state.active[logicalEntityId];
    const record = id
      ? (this.state.incarnations.find((item) => item.incarnationId === id) ?? null)
      : null;
    if (record && record.status !== "active") {
      throw new Error(`Active runtime pointer targets ${record.status} incarnation: ${id}`);
    }
    return record;
  }

  getIncarnation(incarnationId: string): RuntimeIncarnationRecord | null {
    return this.state.incarnations.find((item) => item.incarnationId === incarnationId) ?? null;
  }

  listIncarnations(): RuntimeIncarnationRecord[] {
    return this.state.incarnations.map((record) => structuredClone(record));
  }

  listTransitions(): RuntimeUpgradeTransition[] {
    return this.state.transitions.map((record) => structuredClone(record));
  }

  prepare(input: {
    logicalEntityId: string;
    artifact: ExecutionArtifactRef;
    selectorPolicy: ExecutionSelector;
    compilationCacheKey: string;
    actor: Principal;
    trigger: RuntimeTransitionTrigger;
    scopeRef?: string;
    adoptionPolicy?: AdoptionPolicy;
    now?: number;
  }): PreparedRuntimeTransition {
    verifyExecutionArtifactRef(input.artifact);
    assertPrincipal(input.actor);
    const existing = this.getActive(input.logicalEntityId);
    if (
      existing &&
      existing.artifact.executionDigest === input.artifact.executionDigest &&
      canonicalJson(existing.selectorPolicy) === canonicalJson(input.selectorPolicy) &&
      existing.scopeRef === input.scopeRef
    ) {
      const committed = [...this.state.transitions]
        .reverse()
        .find(
          (transition) =>
            transition.logicalEntityId === input.logicalEntityId &&
            transition.toIncarnationId === existing.incarnationId &&
            transition.status === "committed"
        );
      if (!committed) {
        throw new Error(
          `Active incarnation has no committed transition: ${existing.incarnationId}`
        );
      }
      return { incarnation: structuredClone(existing), transition: structuredClone(committed) };
    }

    const now = input.now ?? Date.now();
    this.cancelPending(input.logicalEntityId, now);
    const generation =
      Math.max(
        0,
        ...this.state.incarnations
          .filter((item) => item.logicalEntityId === input.logicalEntityId)
          .map((item) => item.generation)
      ) + 1;
    const incarnationId = domainHash(
      "vibestudio/runtime-incarnation/v1",
      input.logicalEntityId,
      input.artifact.executionDigest,
      String(generation)
    );
    if (this.getIncarnation(incarnationId)) {
      throw new Error(`Runtime incarnation identity collision: ${incarnationId}`);
    }
    const transitionId = domainHash(
      "vibestudio/runtime-transition/v1",
      input.logicalEntityId,
      existing?.incarnationId ?? "none",
      incarnationId
    );
    const incarnation: RuntimeIncarnationRecord = {
      incarnationId,
      logicalEntityId: input.logicalEntityId,
      artifact: structuredClone(input.artifact),
      selectorPolicy: structuredClone(input.selectorPolicy),
      compilationCacheKey: input.compilationCacheKey,
      generation,
      ...(input.scopeRef ? { scopeRef: input.scopeRef } : {}),
      status: "prepared",
      startedAt: now,
      endedAt: null,
    };
    const transition: RuntimeUpgradeTransition = {
      transitionId,
      logicalEntityId: input.logicalEntityId,
      selector: structuredClone(input.selectorPolicy),
      fromIncarnationId: existing?.incarnationId ?? null,
      toIncarnationId: incarnationId,
      trigger: input.trigger,
      actor: input.actor,
      adoptionPolicy: input.adoptionPolicy ?? { kind: "cache-invalidation" },
      status: "awaiting-adoption",
      error: null,
      createdAt: now,
      committedAt: null,
    };
    this.state.incarnations.push(incarnation);
    this.state.transitions.push(transition);
    this.persist();
    return { incarnation: structuredClone(incarnation), transition: structuredClone(transition) };
  }

  adopt(transitionId: string, now = Date.now()): RuntimeIncarnationRecord {
    const transition = this.transition(transitionId);
    const incarnation = this.requireIncarnation(transition.toIncarnationId);
    const active = this.getActive(transition.logicalEntityId);
    if (transition.status === "committed") {
      if (active?.incarnationId !== incarnation.incarnationId) {
        throw new Error(`Committed transition is not active: ${transitionId}`);
      }
      return structuredClone(incarnation);
    }
    if (transition.status !== "awaiting-adoption") {
      throw new Error(`Cannot adopt ${transition.status} transition: ${transitionId}`);
    }
    if ((active?.incarnationId ?? null) !== transition.fromIncarnationId) {
      throw new Error(`Runtime transition base changed before adoption: ${transitionId}`);
    }
    if (active) {
      active.status = "retired";
      active.endedAt = now;
    }
    incarnation.status = "active";
    transition.status = "committed";
    transition.committedAt = now;
    this.state.active[transition.logicalEntityId] = incarnation.incarnationId;
    this.persist();
    return structuredClone(incarnation);
  }

  fail(transitionId: string, error: { code: string; message: string }, now = Date.now()): void {
    const transition = this.transition(transitionId);
    if (transition.status === "committed") {
      throw new Error(`Cannot fail committed transition: ${transitionId}`);
    }
    if (transition.status === "failed") return;
    if (transition.status === "cancelled") {
      throw new Error(`Cannot fail cancelled transition: ${transitionId}`);
    }
    const incarnation = this.requireIncarnation(transition.toIncarnationId);
    incarnation.status = "failed";
    incarnation.endedAt = now;
    transition.status = "failed";
    transition.error = { ...error, failedAt: now };
    this.persist();
  }

  cancel(transitionId: string, now = Date.now()): void {
    const transition = this.transition(transitionId);
    if (transition.status === "committed") {
      throw new Error(`Cannot cancel committed transition: ${transitionId}`);
    }
    if (transition.status === "cancelled" || transition.status === "failed") return;
    const incarnation = this.requireIncarnation(transition.toIncarnationId);
    incarnation.status = "retired";
    incarnation.endedAt = now;
    transition.status = "cancelled";
    this.persist();
  }

  retire(logicalEntityId: string, now = Date.now()): void {
    const active = this.getActive(logicalEntityId);
    if (!active) return;
    active.status = "retired";
    active.endedAt = now;
    this.state.active = Object.fromEntries(
      Object.entries(this.state.active).filter(([entityId]) => entityId !== logicalEntityId)
    );
    this.persist();
  }

  private cancelPending(logicalEntityId: string, now: number): void {
    for (const transition of this.state.transitions) {
      if (
        transition.logicalEntityId !== logicalEntityId ||
        (transition.status !== "preparing" && transition.status !== "awaiting-adoption")
      ) {
        continue;
      }
      transition.status = "cancelled";
      const incarnation = this.requireIncarnation(transition.toIncarnationId);
      incarnation.status = "retired";
      incarnation.endedAt = now;
    }
  }

  private transition(transitionId: string): RuntimeUpgradeTransition {
    const transition = this.state.transitions.find((item) => item.transitionId === transitionId);
    if (!transition) throw new Error(`Unknown runtime transition: ${transitionId}`);
    return transition;
  }

  private requireIncarnation(incarnationId: string): RuntimeIncarnationRecord {
    const incarnation = this.getIncarnation(incarnationId);
    if (!incarnation) throw new Error(`Runtime incarnation is missing: ${incarnationId}`);
    return incarnation;
  }

  private load(): RuntimeIncarnationFile {
    if (!fs.existsSync(this.filePath)) return emptyState();
    const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as RuntimeIncarnationFile;
    if (
      parsed.version !== 2 ||
      !parsed.active ||
      !Array.isArray(parsed.incarnations) ||
      !Array.isArray(parsed.transitions)
    ) {
      throw new Error(
        `Unsupported runtime incarnation state: ${this.filePath}. Run the scoped runtime-foundations reset.`
      );
    }
    for (const incarnation of parsed.incarnations) verifyExecutionArtifactRef(incarnation.artifact);
    this.assertConsistent(parsed);
    return parsed;
  }

  private assertConsistent(state: RuntimeIncarnationFile): void {
    const incarnationIds = new Set<string>();
    for (const incarnation of state.incarnations) {
      if (incarnationIds.has(incarnation.incarnationId)) {
        throw new Error(`Duplicate runtime incarnation: ${incarnation.incarnationId}`);
      }
      incarnationIds.add(incarnation.incarnationId);
    }
    for (const [entityId, incarnationId] of Object.entries(state.active)) {
      const incarnation = state.incarnations.find((item) => item.incarnationId === incarnationId);
      if (
        !incarnation ||
        incarnation.logicalEntityId !== entityId ||
        incarnation.status !== "active"
      ) {
        throw new Error(
          `Invalid active runtime incarnation pointer: ${entityId} -> ${incarnationId}`
        );
      }
    }
    for (const transition of state.transitions) {
      assertPrincipal(transition.actor);
      if (!incarnationIds.has(transition.toIncarnationId)) {
        throw new Error(`Runtime transition target is missing: ${transition.transitionId}`);
      }
    }
  }

  private persist(): void {
    this.assertConsistent(this.state);
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temp = `${this.filePath}.tmp.${process.pid}`;
    fs.writeFileSync(temp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
    fs.renameSync(temp, this.filePath);
  }
}

function emptyState(): RuntimeIncarnationFile {
  return { version: 2, active: {}, incarnations: [], transitions: [] };
}

function assertPrincipal(value: string): asserts value is Principal {
  if (!/^(host|user|device|code|entity):.+$/.test(value)) {
    throw new Error(`Runtime transition actor is not a canonical principal: ${value}`);
  }
}

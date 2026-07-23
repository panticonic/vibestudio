import { createHash } from "node:crypto";
import type { SessionMissionFact } from "@vibestudio/rpc";
import { compareUtf16CodeUnits } from "@vibestudio/content-addressing";
import { canonicalJson } from "../canonicalJson.js";
import { normalizeWorkspaceRepoPath } from "../runtime/entitySpec.js";

export type MissionState = "draft" | "active" | "needs-reapproval" | "paused" | "retired";

export type MissionEventFilter =
  | { kind: "all" }
  | {
      kind: "field-equals";
      path: readonly [string, ...string[]];
      value: string | number | boolean | null;
    };

export interface MissionCharter {
  taskSpec: string;
  harness: { unit: string; ev: string };
  skills: readonly { path: string; contentHash: string }[];
  toolExposure: {
    services: readonly string[];
    userlandServices: readonly {
      name: string;
      provider: string;
      providerEv: string;
      upgradePolicy: "pinned" | "follow-head";
    }[];
    evalNetwork: "none" | "declared-origins" | "unrestricted";
    declaredOrigins: readonly string[];
  };
  model: { modelId: string; params: Record<string, unknown> };
  trigger:
    | { kind: "manual" }
    | { kind: "cron"; cron: string }
    | { kind: "event"; event: { source: string; filter: MissionEventFilter } };
}

export interface MissionRecord {
  missionId: string;
  name: string;
  revision: number;
  charter: MissionCharter;
  owner: { userId: string; deviceId: string };
  state: MissionState;
  closureDigest: string;
  createdAt: number;
  updatedAt: number;
  seeded?: boolean;
  standingRestrictions?: readonly MissionStandingRestriction[];
}

export interface MissionStandingRestriction {
  capability: string;
  resourceKey: string;
}

const HEX64 = /^[0-9a-f]{64}$/;

export function validateMissionCharter(charter: MissionCharter): void {
  if (!charter.taskSpec || !charter.harness.unit || !HEX64.test(charter.harness.ev)) {
    throw new Error("Mission charter requires task text and an exact harness EV");
  }
  try {
    normalizeWorkspaceRepoPath(charter.harness.unit);
  } catch {
    throw new Error(
      `Mission harness must name one canonical workspace repo: ${JSON.stringify(charter.harness.unit)}`
    );
  }
  const serviceSet = new Set<string>();
  for (const service of charter.toolExposure.services) {
    if (!service || service === "*" || service.includes("\0") || serviceSet.has(service)) {
      throw new Error(`Invalid or duplicate mission service exposure ${JSON.stringify(service)}`);
    }
    serviceSet.add(service);
  }
  const skillSet = new Set<string>();
  for (const skill of charter.skills) {
    if (!skill.path || !HEX64.test(skill.contentHash) || skillSet.has(skill.path)) {
      throw new Error(`Invalid or duplicate mission skill ${JSON.stringify(skill.path)}`);
    }
    skillSet.add(skill.path);
  }
  for (const binding of charter.toolExposure.userlandServices) {
    if (!binding.name || !binding.provider)
      throw new Error("Mission userland bindings must be resolved");
    if (binding.upgradePolicy === "pinned" && !HEX64.test(binding.providerEv)) {
      throw new Error(`Pinned mission provider ${binding.provider} requires an exact EV`);
    }
    if (binding.upgradePolicy === "follow-head" && binding.providerEv !== "@follow-head") {
      throw new Error(`Follow-head mission provider ${binding.provider} must use @follow-head`);
    }
  }
  if (
    charter.toolExposure.evalNetwork === "declared-origins" &&
    charter.toolExposure.declaredOrigins.length === 0
  ) {
    throw new Error("Declared-origins mission network exposure requires at least one origin");
  }
  for (const origin of charter.toolExposure.declaredOrigins) {
    const parsed = new URL(origin);
    if (parsed.origin !== origin)
      throw new Error(`Mission network origin is not canonical: ${origin}`);
  }
  if (charter.trigger.kind === "event") {
    if (!/^[a-z][a-z0-9.-]{0,127}$/u.test(charter.trigger.event.source)) {
      throw new Error("Mission event source is not canonical");
    }
    const filter = charter.trigger.event.filter;
    if (
      filter.kind === "field-equals" &&
      (filter.path.length === 0 ||
        filter.path.some(
          (part) =>
            !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/u.test(part) ||
            part === "__proto__" ||
            part === "prototype" ||
            part === "constructor"
        ))
    ) {
      throw new Error("Mission event filter contains an invalid field path");
    }
  }
}

/** Content address of behavior only; identity, owner, display, state and time are excluded. */
export function missionClosureDigest(charter: MissionCharter): string {
  validateMissionCharter(charter);
  const hash = createHash("sha256");
  const part = (value: string) => hash.update(value, "utf8").update("\0", "utf8");
  part("mission-closure-v1");
  part(sha256(canonicalJson(charter.taskSpec)));
  part("harness");
  part(charter.harness.unit);
  part(charter.harness.ev);
  for (const skill of [...charter.skills].sort((a, b) =>
    compareUtf16CodeUnits(a.path, b.path)
  )) {
    part("skill");
    part(skill.path);
    part(skill.contentHash);
  }
  part(sha256(canonicalJson(charter.toolExposure)));
  part(sha256(canonicalJson(charter.model)));
  part(sha256(canonicalJson(charter.trigger)));
  return hash.digest("hex");
}

export function missionSubject(
  record: Pick<MissionRecord, "missionId" | "closureDigest">
): `mission:${string}` {
  if (!record.missionId.startsWith("msn_") || !HEX64.test(record.closureDigest)) {
    throw new Error("Mission subject requires a canonical id and closure digest");
  }
  return `mission:${record.missionId}@${record.closureDigest}`;
}

export function missionFact(record: MissionRecord): SessionMissionFact {
  if (record.state !== "active") throw new Error(`Mission ${record.missionId} is not active`);
  if (missionClosureDigest(record.charter) !== record.closureDigest) {
    throw new Error(`Mission ${record.missionId} closure has drifted`);
  }
  return {
    missionId: record.missionId,
    closureDigest: record.closureDigest,
    harness: { ...record.charter.harness },
  };
}

export function missionAllowsService(charter: MissionCharter, qualifiedMethod: string): boolean {
  return charter.toolExposure.services.some(
    (entry) =>
      entry === qualifiedMethod ||
      (entry.endsWith(".*") && qualifiedMethod.startsWith(entry.slice(0, -1)))
  );
}

export function missionEventMatches(filter: MissionEventFilter, payload: unknown): boolean {
  if (filter.kind === "all") return true;
  let value = payload;
  for (const part of filter.path) {
    if (
      value === null ||
      typeof value !== "object" ||
      !Object.prototype.hasOwnProperty.call(value, part)
    ) {
      return false;
    }
    value = (value as Record<string, unknown>)[part];
  }
  return Object.is(value, filter.value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

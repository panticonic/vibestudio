import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { getProfileDataPath } from "@vibestudio/env-paths";
import { observeProcessStart } from "@vibestudio/shared/ownedProcessIdentity";
import {
  ledgerDirOf,
  ledgerLiveness,
  readLedger,
  type Ledger,
} from "@vibestudio/shared/ownershipLedger";
import { writeFileAtomicSync } from "../atomicFile.js";

const INSTANCE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

export interface DevInstanceRecord {
  schemaVersion: 1;
  id: string;
  root: string;
  repoRoot: string;
  supervisorPid: number;
  kind: "desktop" | "server";
  lifecycle: "ephemeral" | "persistent";
  /** Private profile root for a clean-room instance. */
  profileRoot?: string;
  generationId: string;
  startedAt: number;
  /**
   * The ownership ledger that claims this instance id. The record is only as
   * alive as that claim: a record whose ledger is gone, replaced, or held by a
   * dead owner names an instance that is not running.
   */
  ledgerId: string;
  /** Distinguishes this claim from a later claim of the same id. */
  ledgerToken: string;
}

export interface DevInstanceReadyRecord {
  schemaVersion: 1;
  instanceGeneration: string;
  status: "existing" | "paired" | "invite-required";
  workspaceName?: string;
  readyAt: number;
}

function canonicalRepoRoot(repoRoot: string): string {
  return fs.realpathSync(path.resolve(repoRoot));
}

function repoKey(repoRoot: string): string {
  return createHash("sha256").update(canonicalRepoRoot(repoRoot)).digest("hex").slice(0, 16);
}

function assertInstanceId(id: string): void {
  if (!INSTANCE_ID_PATTERN.test(id)) {
    throw new Error(
      `Invalid instance id ${JSON.stringify(id)}; use lowercase letters, numbers, "-" or "_"`
    );
  }
}

function registryDir(repoRoot: string): string {
  return path.join(getProfileDataPath(), "dev-instances", repoKey(repoRoot));
}

function registryPath(repoRoot: string, id: string): string {
  assertInstanceId(id);
  return path.join(registryDir(repoRoot), `${id}.json`);
}

/** Where an instance's registry record lives; the instance's own ownership removes it. */
export function devInstanceRecordPath(repoRoot: string, id: string): string {
  return registryPath(canonicalRepoRoot(repoRoot), id);
}

/** The ownership directory every launcher of this profile shares. */
export function devInstanceLedgerDir(): string {
  return ledgerDirOf(getProfileDataPath());
}

/**
 * The ownership claim name of one instance. It carries the checkout key so the
 * same instance id in two checkouts of one profile never contends for a claim.
 */
export function devInstanceLedgerId(repoRoot: string, id: string): string {
  assertInstanceId(id);
  return `instance-${repoKey(repoRoot)}-${id}`;
}

/** The ledger of a record's claim, when that claim is still the one the record names. */
export function readDevInstanceLedger(
  record: Pick<DevInstanceRecord, "ledgerId" | "ledgerToken">
): Ledger | null {
  const ledger = readLedger(devInstanceLedgerDir(), record.ledgerId);
  return ledger && ledger.token === record.ledgerToken ? ledger : null;
}

/** True while the record's claim exists and its owning process incarnation is alive. */
export function devInstanceHolderLive(
  record: Pick<DevInstanceRecord, "ledgerId" | "ledgerToken">
): boolean {
  const ledger = readDevInstanceLedger(record);
  return (
    ledger !== null &&
    ledgerLiveness(ledger) === "live" &&
    observeProcessStart(ledger.owner) === "live"
  );
}

export function devInstanceReadyPath(instance: Pick<DevInstanceRecord, "root">): string {
  return path.join(instance.root, "dev-instance-ready.json");
}

export function clearDevInstanceReady(instance: Pick<DevInstanceRecord, "root">): void {
  fs.rmSync(devInstanceReadyPath(instance), { force: true });
}

export function publishDevInstanceReady(
  instance: Pick<DevInstanceRecord, "root" | "generationId">,
  input: Omit<DevInstanceReadyRecord, "schemaVersion" | "instanceGeneration" | "readyAt">
): DevInstanceReadyRecord {
  const ready: DevInstanceReadyRecord = {
    schemaVersion: 1,
    instanceGeneration: instance.generationId,
    ...input,
    readyAt: Date.now(),
  };
  writeFileAtomicSync(devInstanceReadyPath(instance), `${JSON.stringify(ready, null, 2)}\n`, {
    mode: 0o600,
  });
  return ready;
}

export async function waitForDevInstanceReady(
  instance: Pick<DevInstanceRecord, "root" | "generationId" | "id" | "ledgerId" | "ledgerToken">,
  signal?: AbortSignal
): Promise<DevInstanceReadyRecord> {
  const file = devInstanceReadyPath(instance);
  for (;;) {
    signal?.throwIfAborted();
    try {
      const value = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<DevInstanceReadyRecord>;
      if (
        value.schemaVersion !== 1 ||
        value.instanceGeneration !== instance.generationId ||
        (value.status !== "existing" &&
          value.status !== "paired" &&
          value.status !== "invite-required") ||
        typeof value.readyAt !== "number" ||
        !Number.isFinite(value.readyAt) ||
        (value.status !== "invite-required" &&
          (typeof value.workspaceName !== "string" || value.workspaceName.length === 0))
      ) {
        // A persistent instance root deliberately survives supervisor restarts.
        // A structurally valid record from another generation is therefore not
        // corruption; it is simply not the barrier this caller is waiting for.
        if (
          value.schemaVersion === 1 &&
          typeof value.instanceGeneration === "string" &&
          value.instanceGeneration !== instance.generationId
        ) {
          throw Object.assign(new Error("stale developer instance readiness record"), {
            code: "ESTALE",
          });
        }
        throw new Error(`Developer instance readiness record is invalid: ${file}`);
      }
      return value as DevInstanceReadyRecord;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ESTALE" && !(error instanceof SyntaxError)) {
        throw error;
      }
    }
    // The owner's exit is the terminal failure event; elapsed time is not.
    if (!devInstanceHolderLive(instance)) {
      throw new Error(
        `Vibestudio instance ${JSON.stringify(instance.id)} exited before CLI readiness`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

export function persistentInstanceRoot(repoRoot: string, id: string): string {
  assertInstanceId(id);
  return path.join(getProfileDataPath(), "instance-state", repoKey(repoRoot), id);
}

export function generatedInstanceId(kind: DevInstanceRecord["kind"]): string {
  return `${kind}-${randomBytes(4).toString("hex")}`;
}

/**
 * Record a running instance. The caller must hold the instance's ownership
 * claim (`ledgerId`): the claim, not this record, is what makes the id
 * exclusive, so registration is a plain atomic write bound to that claim.
 */
export function registerDevInstance(
  input: Omit<DevInstanceRecord, "schemaVersion" | "repoRoot" | "generationId" | "ledgerToken"> & {
    repoRoot: string;
  }
): DevInstanceRecord {
  assertInstanceId(input.id);
  const root = path.resolve(input.root);
  const profileRoot = input.profileRoot ? path.resolve(input.profileRoot) : undefined;
  if (
    profileRoot &&
    (input.lifecycle !== "ephemeral" || profileRoot !== path.join(root, "profile"))
  ) {
    throw new Error("A private developer profile must be the ephemeral instance's profile root");
  }
  const repoRoot = canonicalRepoRoot(input.repoRoot);
  const ledger = readLedger(devInstanceLedgerDir(), input.ledgerId);
  if (!ledger || ledgerLiveness(ledger) !== "live") {
    throw Object.assign(
      new Error(
        `Vibestudio instance ${JSON.stringify(input.id)} cannot be registered without a live ownership claim`
      ),
      { code: "EOWNERSHIP" }
    );
  }
  const record: DevInstanceRecord = {
    schemaVersion: 1,
    ...input,
    generationId: randomBytes(16).toString("hex"),
    root,
    ...(profileRoot ? { profileRoot } : {}),
    repoRoot,
    ledgerToken: ledger.token,
  };
  fs.mkdirSync(registryDir(repoRoot), { recursive: true, mode: 0o700 });
  writeFileAtomicSync(registryPath(repoRoot, record.id), `${JSON.stringify(record, null, 2)}\n`, {
    mode: 0o600,
  });
  return record;
}

export function unregisterDevInstance(repoRoot: string, id: string): void {
  fs.rmSync(registryPath(repoRoot, id), { force: true });
}

export function readDevInstanceRecord(repoRoot: string, id: string): DevInstanceRecord {
  const file = registryPath(repoRoot, id);
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `Unknown Vibestudio instance ${JSON.stringify(id)} in this checkout. ` +
          "Use the id printed by pnpm dev or pnpm server:live."
      );
    }
    throw new Error(
      `Cannot read Vibestudio instance ${JSON.stringify(id)}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as Partial<DevInstanceRecord>).schemaVersion !== 1
  ) {
    throw new Error(`Vibestudio instance record ${file} has an unsupported schema`);
  }
  const record = value as Partial<DevInstanceRecord>;
  if (
    typeof record.id !== "string" ||
    record.id !== id ||
    typeof record.root !== "string" ||
    !path.isAbsolute(record.root) ||
    typeof record.repoRoot !== "string" ||
    record.repoRoot !== canonicalRepoRoot(repoRoot) ||
    typeof record.supervisorPid !== "number" ||
    !Number.isInteger(record.supervisorPid) ||
    record.supervisorPid <= 0 ||
    (record.kind !== "desktop" && record.kind !== "server") ||
    (record.lifecycle !== "ephemeral" && record.lifecycle !== "persistent") ||
    (record.profileRoot !== undefined &&
      (typeof record.profileRoot !== "string" ||
        !path.isAbsolute(record.profileRoot) ||
        record.lifecycle !== "ephemeral" ||
        record.profileRoot !== path.join(record.root, "profile"))) ||
    typeof record.ledgerId !== "string" ||
    record.ledgerId.length === 0 ||
    typeof record.ledgerToken !== "string" ||
    record.ledgerToken.length === 0 ||
    typeof record.generationId !== "string" ||
    !/^[a-f0-9]{32}$/u.test(record.generationId) ||
    typeof record.startedAt !== "number" ||
    !Number.isFinite(record.startedAt)
  ) {
    throw new Error(`Vibestudio instance record ${file} is invalid`);
  }
  return record as DevInstanceRecord;
}

export function resolveDevInstance(repoRoot: string, id: string): DevInstanceRecord {
  const record = readDevInstanceRecord(repoRoot, id);
  if (!devInstanceHolderLive(record)) {
    throw new Error(
      `Vibestudio instance ${JSON.stringify(id)} is no longer running ` +
        `(stale record: ${registryPath(repoRoot, id)})`
    );
  }
  return record;
}

/**
 * Transfer an exact surviving generation to the owner holding `adopter`'s
 * claim. The previous claim must no longer have a live owner.
 */
export function adoptDevInstance(
  repoRoot: string,
  expected: Pick<DevInstanceRecord, "id" | "generationId" | "root">,
  adopter: { ledgerId: string; supervisorPid?: number }
): DevInstanceRecord {
  const current = readDevInstanceRecord(repoRoot, expected.id);
  if (
    current.generationId !== expected.generationId ||
    current.root !== path.resolve(expected.root)
  ) {
    throw Object.assign(new Error("Developer instance generation changed before adoption"), {
      code: "EOWNERSHIP",
    });
  }
  if (current.ledgerId !== adopter.ledgerId && devInstanceHolderLive(current)) {
    throw Object.assign(
      new Error(`Developer instance still has a live owner (claim ${current.ledgerId})`),
      { code: "EOWNERSHIP" }
    );
  }
  const ledger = readLedger(devInstanceLedgerDir(), adopter.ledgerId);
  if (!ledger || ledgerLiveness(ledger) !== "live") {
    throw Object.assign(new Error("The adopting owner holds no live ownership claim"), {
      code: "EOWNERSHIP",
    });
  }
  const adopted: DevInstanceRecord = {
    ...current,
    supervisorPid: adopter.supervisorPid ?? process.pid,
    ledgerId: adopter.ledgerId,
    ledgerToken: ledger.token,
  };
  writeFileAtomicSync(
    registryPath(adopted.repoRoot, adopted.id),
    `${JSON.stringify(adopted, null, 2)}\n`,
    { mode: 0o600 }
  );
  return adopted;
}

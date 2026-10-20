import * as fs from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  bootId,
  captureProcessStart,
  type ProcessStart,
} from "@vibestudio/shared/ownedProcessIdentity";
import {
  claimLedger,
  ledgerFile,
  writeLedger,
  type Ledger,
  type OwnershipLifetime,
} from "@vibestudio/shared/ownershipLedger";
import {
  devInstanceLedgerDir,
  devInstanceLedgerId,
  registerDevInstance,
  type DevInstanceRecord,
} from "../instanceRegistry.js";

/**
 * A process incarnation that is provably dead: it started and exited, so its
 * pid and start coordinate name nothing alive.
 */
export function deadProcessStart(): ProcessStart {
  const child = spawnSync(process.execPath, ["-e", ""], { stdio: "ignore" });
  const dead = captureProcessStart(process.pid);
  return { pid: child.pid, startCoordinate: `${dead.startCoordinate}-dead`, bootId: bootId() };
}

/**
 * Claim `id` in the profile's ownership directory with a ledger whose owner
 * and reaper are this test process (so the claim reads as live) unless told
 * otherwise. The ledger is data only; no reaper process stands behind it.
 */
export async function claimFixtureLedger(input: {
  id: string;
  lifetime?: OwnershipLifetime;
  state?: Ledger["state"];
  meta?: Record<string, unknown>;
  owner?: ProcessStart;
  reaper?: ProcessStart;
  paths?: Ledger["paths"];
}): Promise<Ledger> {
  const self = captureProcessStart(process.pid);
  const ledger: Ledger = {
    version: 1,
    id: input.id,
    token: randomBytes(16).toString("hex"),
    bootId: bootId(),
    lifetime: input.lifetime ?? "until-stop",
    state: input.state ?? "ready",
    owner: input.owner ?? self,
    reaper: input.reaper ?? self,
    groups: [],
    paths: input.paths ?? [],
    meta: input.meta ?? {},
  };
  fs.mkdirSync(devInstanceLedgerDir(), { recursive: true, mode: 0o700 });
  const claim = await claimLedger(devInstanceLedgerDir(), ledger);
  if (!claim.claimed) throw new Error(`fixture ledger ${input.id} is already held`);
  return ledger;
}

/**
 * A registered instance backed by a fixture claim. Registration needs a live
 * claim, so the claim is live while the record is written; an `owner` or
 * `reaper` override then replaces it, which is how a record whose holder died
 * is built.
 */
export async function registerFixtureInstance(
  input: Omit<
    Parameters<typeof registerDevInstance>[0],
    "ledgerId" | "supervisorPid" | "startedAt" | "kind" | "lifecycle"
  > &
    Partial<Pick<DevInstanceRecord, "kind" | "lifecycle" | "supervisorPid" | "startedAt">> & {
      ledger?: Omit<Parameters<typeof claimFixtureLedger>[0], "id">;
    }
): Promise<{ instance: DevInstanceRecord; ledger: Ledger }> {
  const { ledger: ledgerOptions, ...record } = input;
  const { owner, reaper, ...claimOptions } = ledgerOptions ?? {};
  let ledger = await claimFixtureLedger({
    id: devInstanceLedgerId(record.repoRoot, record.id),
    ...claimOptions,
  });
  const instance = registerDevInstance({
    kind: "server",
    lifecycle: "persistent",
    supervisorPid: process.pid,
    startedAt: Date.now(),
    ...record,
    ledgerId: ledger.id,
  });
  if (owner || reaper) {
    ledger = { ...ledger, ...(owner ? { owner } : {}), ...(reaper ? { reaper } : {}) };
    writeLedger(ledgerFile(devInstanceLedgerDir(), ledger.id), ledger);
  }
  return { instance, ledger };
}

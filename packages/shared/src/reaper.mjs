// The reaper (R): a tiny plain-Node process that owns retirement for one owner.
//
// Started by `Ownership.open` with `process.execPath` (as Node: under Electron
// the client sets ELECTRON_RUN_AS_NODE), in its own process group (outside
// every workload), over a Node IPC channel. That channel is the
// LEASE: its end (`disconnect`) is the only revocation primitive, and it fires
// when the owner is SIGKILLed too. R writes the ledger before anything it
// records can start, retires everything on `release` or lease loss, and exits
// 0 on success. A retirement failure leaves `<id>.json` and `<id>.result` on
// disk and exits 1; the claim itself failing exits 3.
//
// PACKAGING CONTRACT: this file imports only `node:` builtins and relative
// sibling `.mjs` files, never a workspace package, TypeScript or a loader, so
// it ships as plain files. The exact list is `OWNERSHIP_REAPER_FILES` in
// ownershipFiles.mjs; ownership.test.ts fails if the import graph drifts from it.
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  bootId,
  captureProcessStart,
  observeOwnedProcessGroupReceipt,
  parseOwnedProcessIdentity,
  setOomScoreAdj,
} from "./ownedProcessIdentity.mjs";
import {
  claimLedger,
  ledgerDirOf,
  ledgerFile,
  retireGroup,
  retireLedger,
  scratchDirOf,
  writeLedger,
} from "./ownershipLedger.mjs";

const OOM_SCORE_ADJ = 500;

const config = JSON.parse(process.argv[2] ?? "null");
const send = (message) =>
  new Promise((resolve) => {
    if (!process.connected) return resolve();
    try {
      process.send(message, () => resolve());
    } catch {
      resolve();
    }
  });
const serialize = (error) => ({
  message: error instanceof Error ? error.message : String(error),
  ...(error?.code === undefined ? {} : { code: String(error.code) }),
  ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
});
const flatten = (error) => (error instanceof AggregateError ? error.errors : [error]);

let ledger;
let file;
let dir;
let claimed = false;
let revoked = false;
let retiring = null;
let escalated = false;
const escalatedKeys = new Set();
const groupRetirements = new Map();

function persist() {
  writeLedger(file, ledger);
}

function retireOne(group) {
  let retirement = groupRetirements.get(group.key);
  if (!retirement) {
    retirement = retireGroup(group, {
      escalated: () => escalated || escalatedKeys.has(group.key),
    }).then(
      () => {
        ledger.groups = ledger.groups.filter((entry) => entry.key !== group.key);
        if (!retiring) persist();
      },
      (error) => {
        groupRetirements.delete(group.key);
        throw error;
      }
    );
    groupRetirements.set(group.key, retirement);
  }
  return retirement;
}

function retireEverything() {
  retiring ??= (async () => {
    try {
      await retireLedger(structuredClone(ledger), {
        dir,
        file,
        retireGroup: retireOne,
        escalated: () => escalated,
      });
      return { ok: true, failures: [] };
    } catch (error) {
      return { ok: false, failures: flatten(error).map(serialize) };
    }
  })();
  return retiring;
}

async function finish(outcome, rid) {
  if (rid !== undefined) {
    await send({ t: "released", rid, ok: outcome.ok, failures: outcome.failures });
  }
  if (process.connected) process.disconnect();
  process.exit(outcome.ok ? 0 : 1);
}

function register(message) {
  const { pid, identity, kill, label, outlives } = message.group;
  if (kill !== "graceful" && kill !== "immediate") throw new Error("Invalid kill mode");
  let entry;
  if (identity === null) {
    if (process.platform !== "win32") throw new Error("Process identity is required");
    entry = { key: String(pid), pid, identity: null, kill, ...(outlives === true ? { outlives: true } : {}) };
  } else {
    const parsed = parseOwnedProcessIdentity(identity);
    entry = {
      key: `${parsed.pid}:${parsed.startCoordinate}`,
      pid: parsed.pid,
      identity: parsed,
      kill,
    };
    const observation = observeOwnedProcessGroupReceipt(parsed);
    // A workload that already exited and left nothing needs no record.
    if (observation.status === "absent") return { recorded: false };
    if (observation.status === "unknown")
      throw new Error("Process group identity cannot be proven");
    // A group handed to a successor owner is not this owner's workload: it is
    // recorded, never retired here, and not marked as the OOM killer's pick.
    if (outlives === true) entry.outlives = true;
    else entry.oom = setOomScoreAdj(parsed.pid, OOM_SCORE_ADJ);
  }
  if (typeof label === "string") entry.label = label;
  if (!ledger.groups.some((group) => group.key === entry.key)) ledger.groups.push(entry);
  persist();
  return { recorded: true, oom: entry.oom ?? null };
}

function scratch(message) {
  const prefix = String(message.prefix).replace(/[^A-Za-z0-9._-]/gu, "_");
  const target = path.join(
    scratchDirOf(config.profileDir),
    `${prefix}${randomBytes(6).toString("hex")}`
  );
  // Recorded before it exists: a death in between leaves a removal of nothing.
  ledger.paths.push({ path: target, kind: "scratch" });
  persist();
  fs.mkdirSync(target, { mode: 0o700 });
  return { path: target };
}

async function handle(message) {
  switch (message.t) {
    case "register":
      return register(message);
    case "scratch":
      return scratch(message);
    case "own": {
      if (typeof message.path !== "string" || !path.isAbsolute(message.path)) {
        throw new Error("Owned paths must be absolute");
      }
      ledger.paths.push({
        path: message.path,
        kind: "path",
        ...(typeof message.label === "string" ? { label: message.label } : {}),
      });
      persist();
      return {};
    }
    case "meta":
      ledger.meta = { ...ledger.meta, ...message.patch };
      persist();
      return {};
    case "ready":
      ledger.state = "ready";
      persist();
      return {};
    case "escalate":
      escalated = true;
      return {};
    case "retire": {
      const group = ledger.groups.find((entry) => entry.key === message.key);
      if (!group) return {};
      const immediate = message.mode === "immediate";
      if (immediate) escalatedKeys.add(group.key);
      await retireOne(immediate ? { ...group, kill: "immediate" } : group);
      return {};
    }
    default:
      throw new Error(`Unknown reaper request ${String(message.t)}`);
  }
}

async function onMessage(message) {
  if (!message || typeof message.rid !== "number") return;
  if (message.t === "release") {
    await finish(await retireEverything(), message.rid);
    return;
  }
  try {
    if (retiring) throw new Error("Ownership is already being retired");
    const value = await handle(message);
    await send({ t: "reply", rid: message.rid, ok: true, value });
  } catch (error) {
    await send({ t: "reply", rid: message.rid, ok: false, failure: serialize(error) });
  }
}

async function main() {
  if (!config || !process.send) {
    process.stderr.write("reaper requires a configuration and an IPC channel\n");
    process.exit(2);
  }
  // The lease: from here on, losing the owner means retiring.
  process.on("disconnect", () => {
    revoked = true;
    if (claimed) void retireEverything().then((outcome) => finish(outcome));
    else process.exit(2);
  });
  for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
    process.on(signal, () => {
      revoked = true;
      if (claimed) void retireEverything().then((outcome) => finish(outcome));
      else process.exit(2);
    });
  }
  dir = ledgerDirOf(config.profileDir);
  fs.mkdirSync(scratchDirOf(config.profileDir), { recursive: true, mode: 0o700 });
  file = ledgerFile(dir, config.id);
  ledger = {
    version: 1,
    id: config.id,
    token: randomBytes(16).toString("hex"),
    bootId: bootId(),
    lifetime: config.lifetime,
    state: "claimed",
    owner: config.owner,
    reaper: captureProcessStart(process.pid),
    groups: [],
    paths: [],
    meta: config.meta ?? {},
  };
  const claim = await claimLedger(dir, ledger);
  if (!claim.claimed) {
    await send({ t: "claim-failed", holder: claim.holder });
    process.exit(3);
  }
  claimed = true;
  if (revoked) {
    await finish(await retireEverything());
    return;
  }
  process.on("message", (message) => void onMessage(message));
  await send({ t: "claimed", token: ledger.token });
}

main().catch(async (error) => {
  await send({ t: "claim-error", failure: serialize(error) });
  process.exit(claimed ? 70 : 4);
});

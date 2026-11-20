import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { tsImport } from "tsx/esm/api";

const exec = promisify(execFile);
const sources = ["workspace", "hub"];
const instance = `approval-visibility-${randomUUID().slice(0, 8)}`;
const provision = ["--silent", "system-test", "--instance", instance, "--workspace", "system"];
const cli = ["--import", "tsx", "src/dev/runCli.ts", "--instance", instance];

async function readInitialWatch() {
  const watcher = spawn("node", [...cli, "approvals", "watch", "--json"], {
    stdio: ["ignore", "pipe", "pipe"],
    signal: AbortSignal.timeout(30_000),
  });
  const exit = new Promise((resolve) => watcher.once("close", resolve));
  let failure;
  watcher.on("error", (error) => {
    failure = error;
  });
  watcher.stderr.resume();
  const lines = createInterface({ input: watcher.stdout });
  const receipts = [];
  const acknowledged = new Set();
  const snapshots = new Set();
  try {
    for await (const line of lines) {
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        throw new Error("Approval watch returned an invalid JSON record");
      }
      assert(sources.includes(row.source), "Watch receipt needs an exact queue source");
      if (row.kind === "watching") {
        assert(!acknowledged.has(row.source), "Unexpected repeated watch acknowledgement");
        acknowledged.add(row.source);
        receipts.push({ source: row.source, kind: "acknowledged", ids: [] });
      } else if (row.event === "shell-approval:pending-changed") {
        assert(acknowledged.has(row.source), "Snapshot arrived before watch acknowledgement");
        const ids = row.payload.pending.map(({ approvalId }) => approvalId);
        assert(ids.every((id) => typeof id === "string" && id.length > 0));
        receipts.push({ source: row.source, kind: "snapshot", ids });
        snapshots.add(row.source);
      }
      if (snapshots.size === sources.length) break;
    }
  } finally {
    watcher.kill("SIGTERM");
    await exit;
  }
  if (failure) throw failure;
  assert.equal(snapshots.size, sources.length, "Expected both initial approval queue snapshots");
  return receipts;
}

async function usePairedReceipts(scratch) {
  const receipts = await readInitialWatch();
  let list;
  try {
    const { stdout } = await exec("node", [...cli, "approvals", "list", "--json"], {
      timeout: 30_000,
    });
    list = JSON.parse(stdout);
  } catch {
    throw new Error("The paired CLI could not list both approval queues");
  }
  assert(
    list.every(
      ({ source, approvalId }) =>
        sources.includes(source) && typeof approvalId === "string" && approvalId.length > 0
    ),
    "Expected labelled list receipts"
  );
  const aliases = new Map();
  const redact = (id) => {
    if (!aliases.has(id)) aliases.set(id, `pending-${aliases.size + 1}`);
    return aliases.get(id);
  };
  const surfaces = sources.map((source) => ({
    source,
    state: "visible",
    ids: list.filter((row) => row.source === source).map(({ approvalId }) => redact(approvalId)),
  }));
  const observedSurfaces = sources.map((source) =>
    receipts.findLast((row) => row.source === source && row.kind === "snapshot").ids.map(redact)
  );
  assert.deepEqual(
    observedSurfaces,
    surfaces.map(({ ids }) => ids),
    "Queue changed between watch and list"
  );
  const owner = surfaces.find(({ ids }) => ids.length > 0);
  const input = {
    id: "approval-queue-live-cli-readback",
    request: {
      goal: "Check the queues available to the paired device and locate the assigned pending request.",
      caller: "device-workspace",
      approvalId: owner?.ids[0] ?? "unlisted-live-request",
      receipts: receipts.map(({ ids, ...receipt }) => ({ ...receipt, ids: ids.map(redact) })),
    },
    expected: {
      coverage: "complete",
      surfaces,
      location: owner
        ? { status: "located", source: owner.source }
        : { status: "absent", source: null },
    },
  };
  const observation = path.join(scratch, "approval-readback.json");
  const bank = path.join(scratch, "bank.jsonl");
  const { liveApprovalTransition } = await tsImport("./lib/approval-transition-observation.ts", import.meta.url);
  const transition = await liveApprovalTransition(instance);
  await writeFile(observation, JSON.stringify([input, transition]), { mode: 0o600 });
  const output = await open(bank, "wx", 0o600);
  try {
    await new Promise((resolve, reject) => {
      const taskBank = spawn("pnpm", ["--silent", "natlang:tasks"], {
        stdio: ["ignore", output.fd, "inherit"],
      });
      taskBank.once("error", reject);
      taskBank.once("close", (code) =>
        code === 0 ? resolve() : reject(new Error("Cannot read Natlang task bank"))
      );
    });
  } finally {
    await output.close();
  }
  return {
    observation,
    bank,
    queueCounts: Object.fromEntries(surfaces.map(({ source, ids }) => [source, ids.length])),
  };
}

const scratch = await mkdtemp(path.join(tmpdir(), "vibe-approval-readback-"));
try {
  let evidence;
  try {
    await exec("pnpm", [...provision, "doctor"], { timeout: 240_000, maxBuffer: 4 * 1024 * 1024 });
    evidence = await usePairedReceipts(scratch);
  } finally {
    await exec("pnpm", [...provision, "stop"], { timeout: 45_000 });
  }
  const result = await exec(
    "node",
    [
      "scripts/run-userland-tests.mjs",
      "--template",
      "base",
      "--filter",
      "packages/natlang/src/vibestudio-workflow-program.test.ts",
      "--test-name",
      "describes the typed workflows in the installed template domains",
    ],
    {
      env: {
        ...process.env,
        VIBESTUDIO_WORKFLOW_BANK_JSONL: evidence.bank,
        VIBESTUDIO_APPROVAL_VISIBILITY_SMOKE_JSON: evidence.observation,
      },
      timeout: 240_000,
    }
  );
  console.log(result.stdout.trim());
  console.log(JSON.stringify({ passed: true, queues: evidence.queueCounts, transition: "no-longer-listed" }));
} finally {
  await rm(scratch, { recursive: true, force: true });
}

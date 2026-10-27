import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Ownership } from "@vibestudio/shared/ownership";
import { ledgerDirOf, listLedgers } from "@vibestudio/shared/ownershipLedger";
import {
  parseOptions,
  readUpdateReceipts,
  verifyUpgrade,
  describeFailure,
  startupFailure,
  retireNestedProfile,
  markerApprovalMatches,
  retainProfileFailureLogs,
  phasePaneReady,
} from "./product-upgrade-smoke.mjs";

const marker = {
  id: "marker",
  title: "Retained title",
  stateArgs: { upgradeRetention: "unique-authored-state" },
  workspaceId: "personal",
  localSource: {
    workspaceId: "system",
    repoPath: "clients/desktop-browser",
    path: "upgrade-retention.txt",
    fileId: "local-file",
    text: "Exact local source bytes\n",
  },
};
const receipt = {
  workspaceId: "system",
  sourceUrl: "git+https://example.test/system.git",
  fromCommit: "old",
  toCommit: "new",
  operationId: "update-1",
  status: "published",
};
const phase = (commit, receipts = []) => ({
  workspaces: [
    { workspaceId: "system", installed: [{ pin: { url: receipt.sourceUrl, commit } }] },
    {
      workspaceId: "personal",
      installed: [{ pin: { url: "git+https://example.test/personal.git", commit: "unchanged" } }],
    },
  ],
  localSource: {
    fileId: marker.localSource.fileId,
    content: { kind: "text", text: marker.localSource.text },
    contentHash: "local-content-hash",
  },
  panelIds: [marker.id],
  panelTitles: [marker.title],
  markerPresentation: {
    id: marker.id,
    title: marker.title,
    source: "about/new",
    contextId: "user-context",
    stateArgs: { ...marker.stateArgs },
  },
  receipts,
});
const scenario = () => [
  phase("old"),
  phase("new", [receipt]),
  phase("new", [{ ...receipt, fromCommit: "new", status: "current" }]),
  marker,
];

test("accepts only a published source change with retained workspace and panel state, then a no-op restart", () => {
  assert.deepEqual(verifyUpgrade(...scenario()), [
    { workspaceId: "system", sourceUrl: receipt.sourceUrl, fromCommit: "old", toCommit: "new" },
  ]);
});

test("rejects unchanged installed source even if a success log was emitted", () => {
  const [before, after, restart] = scenario();
  after.workspaces[0].installed[0].pin.commit = "old";
  assert.throws(
    () => verifyUpgrade(before, after, restart, marker),
    /did not change any installed/
  );
});

test("rejects replacement of an existing workspace or user panel context", () => {
  const [before, after, restart] = scenario();
  after.workspaces[0].workspaceId = "replacement";
  assert.throws(() => verifyUpgrade(before, after, restart, marker), /workspace identities/);
  after.workspaces[0].workspaceId = "system";
  after.markerPresentation.contextId = "replacement-context";
  assert.throws(() => verifyUpgrade(before, after, restart, marker), /marker context changed/);
});

test("retains authored panel state independently of the running page's display title", () => {
  const [before, after, restart] = scenario();
  before.markerPresentation.title = "New Panel";
  after.markerPresentation.title = "New Panel";
  restart.markerPresentation.title = "about/new";
  assert.equal(verifyUpgrade(before, after, restart, marker).length, 1);
  restart.markerPresentation.stateArgs.upgradeRetention = "replacement";
  assert.throws(
    () => verifyUpgrade(before, after, restart, marker),
    /authored panel state changed/
  );
});

test("rejects loss, content replacement, or identity replacement of a nonconflicting local source edit", () => {
  for (const mutate of [
    (after) => {
      after.localSource = null;
    },
    (after) => {
      after.localSource.content.text = "upstream replaced local source\n";
    },
    (after) => {
      after.localSource.fileId = "replacement-file";
    },
  ]) {
    const [before, after, restart] = scenario();
    mutate(after);
    assert.throws(() => verifyUpgrade(before, after, restart, marker), /local source/);
  }
});

test("rejects a second publication on an unchanged product restart", () => {
  const [before, after, restart] = scenario();
  restart.receipts.push(receipt);
  assert.throws(() => verifyUpgrade(before, after, restart, marker), /published another/);
});

test("rejects a publication receipt that does not explain the installed source change", () => {
  const [before, after, restart] = scenario();
  after.receipts = [{ ...receipt, toCommit: "wrong" }];
  assert.throws(
    () => verifyUpgrade(before, after, restart, marker),
    /no matching publication receipt/
  );
});

test("parses exact startup receipts and preserves authoritative staged conflicts", () => {
  const conflict = { ...receipt, status: "conflicts" };
  assert.deepEqual(
    readUpdateReceipts(`ordinary log\n[WorkspaceUpdates] ${JSON.stringify(conflict)}\n`),
    [conflict]
  );
  assert.throws(() => readUpdateReceipts("[WorkspaceUpdates] not-json"), /Malformed/);
  assert.throws(
    () => readUpdateReceipts('[WorkspaceUpdates] {"status":"current"}'),
    /workspaceId\/status/
  );
});

test("requires both source collections and a positive diagnostic deadline", () => {
  assert.throws(() => parseOptions([]), /--before and --after/);
  assert.throws(() => parseOptions(["--timeout-ms", "0"]), /positive diagnostic/);
  assert.equal(parseOptions(["--help"]).help, true);
});

test("failure evidence preserves the original process exit through observation causes and cleanup aggregation", () => {
  const exit = Object.assign(
    new Error("before exited before completing observation (133); see before.log"),
    { code: "EPROCESS", exitCode: 133 }
  );
  const observation = new Error("waiting for product inspector endpoints", { cause: exit });
  const failure = new AggregateError(
    [observation, new Error("inspector cleanup failed")],
    "Product observation and retirement failed",
    { cause: observation }
  );
  const evidence = describeFailure(failure);
  assert.equal(evidence.message, failure.message);
  assert.equal(evidence.cause.message, observation.message);
  assert.equal(evidence.cause.cause.message, exit.message);
  assert.equal(evidence.cause.cause.exitCode, 133);
  assert.equal(evidence.cause.cause.code, "EPROCESS");
  assert.equal(evidence.errors[1].message, "inspector cleanup failed");
  assert.match(JSON.stringify(evidence), /before.log/);
});

test("failure evidence bounds oversized and cyclic diagnostic graphs", () => {
  const error = new Error("x".repeat(50_000));
  error.cause = error;
  const evidence = describeFailure(error);
  assert.equal(evidence.message.length, 8192);
  assert.match(evidence.cause.message, /already recorded/);
  assert(JSON.stringify(evidence).length < 20_000);
});

test("propagates the full presented startup recovery failure without waiting or retrying", () => {
  const error = startupFailure({
    header: {
      tone: "error",
      eyebrow: "Cannot start",
      title: "Workspace launch updates failed",
      copy: "Templates extension needs your review before it can run",
    },
    diagnostics: "AggregateError: update failed\nCaused by: exact unit admission denied",
    logPath: "/private/profile/logs/hub.log",
  });
  assert.equal(error.message, "Workspace launch updates failed");
  const evidence = describeFailure(error);
  assert.equal(evidence.code, "EPRODUCTSTARTUP");
  assert.match(evidence.detail, /needs your review/);
  assert.match(evidence.diagnostics, /exact unit admission denied/);
  assert.equal(evidence.logPath, "/private/profile/logs/hub.log");
});

test("pending approval and build presentations remain live", () => {
  for (const eyebrow of ["Starting", "Before startup", "Review code before starting"])
    assert.equal(startupFailure({ header: { tone: "normal", eyebrow } }), null);
});

test("uses presented terminal recovery DOM only when it explicitly says Cannot start", () => {
  assert.equal(
    startupFailure({
      header: {
        tone: "error",
        eyebrow: "Cannot start",
        title: "Startup stopped",
        copy: "Original reason",
      },
    }).message,
    "Startup stopped"
  );
  assert.equal(
    startupFailure({
      header: {
        tone: "normal",
        eyebrow: "Starting",
        title: "Starting workspace",
        copy: "Still preparing",
      },
    }),
    null
  );
});

test("private profile retirement joins a live nested reaper before removing outer scratch", async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "product-nested-profile-"));
  let nested;
  let retirement;
  try {
    nested = await Ownership.open({ profileDir: profile, lifetime: "leased" });
    const scratch = await nested.scratch("retained-");
    fs.writeFileSync(path.join(scratch, "marker.txt"), "Still owned\n");
    retirement = retireNestedProfile(profile);
    // Sweep must not remove a live owner's paths. Actual owner release below
    // is the terminal event that allows its reaper's retirement to complete.
    await Promise.resolve();
    assert.equal(fs.readFileSync(path.join(scratch, "marker.txt"), "utf8"), "Still owned\n");
    await nested.release();
    await retirement;
    assert.deepEqual(listLedgers(ledgerDirOf(profile)), []);
    assert.equal(fs.existsSync(scratch), false);
  } finally {
    await nested?.release();
    await retirement;
    fs.rmSync(profile, { recursive: true, force: true });
  }
});

test("ordinary marker approval pumping only matches the active method, caller, and one-shot decision", () => {
  const operation = { method: "vcs.push" };
  const approval = {
    kind: "capability",
    callerKind: "client",
    callerId: "desktop-client",
    snapshot: { service: "vcs", method: "push" },
    allowedDecisions: ["once", "deny"],
  };
  assert.equal(markerApprovalMatches(approval, operation, "desktop-client"), true);
  for (const other of [
    { ...approval, callerId: "another-client" },
    { ...approval, callerKind: "worker" },
    { ...approval, kind: "browser-permission" },
    { ...approval, snapshot: { service: "vcs", method: "edit" } },
    { ...approval, snapshot: { service: "fs", method: "push" } },
    { ...approval, allowedDecisions: ["version", "deny"] },
    { ...approval, lifecycle: { state: "preparing" } },
  ])
    assert.equal(markerApprovalMatches(other, operation, "desktop-client"), false);
});

test("failure evidence retains bounded private profile log tails before scratch retirement", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "product-failure-evidence-"));
  const profile = path.join(root, "profile");
  const output = path.join(root, "evidence");
  try {
    fs.mkdirSync(path.join(profile, "logs"), { recursive: true });
    fs.mkdirSync(path.join(profile, "workspaces", "owned", "state", "logs"), { recursive: true });
    fs.mkdirSync(output);
    fs.writeFileSync(
      path.join(profile, "logs", "hub.log"),
      "x".repeat(300_000) + "original server stack"
    );
    fs.writeFileSync(
      path.join(profile, "workspaces", "owned", "state", "logs", "server.log"),
      "workspace original error"
    );
    fs.writeFileSync(path.join(profile, "logs", "credentials.json"), "unrelated private data");
    const logs = retainProfileFailureLogs(profile, output);
    fs.rmSync(profile, { recursive: true });
    assert.equal(logs.length, 2);
    const hub = logs.find((entry) => entry.source === path.join("logs", "hub.log"));
    assert.equal(hub.bytes, 256 * 1024);
    assert.equal(hub.truncated, true);
    assert(fs.readFileSync(path.join(output, hub.file), "utf8").endsWith("original server stack"));
    assert.equal(fs.statSync(path.join(output, hub.file)).mode & 0o777, 0o600);
    assert.equal(
      fs.readFileSync(path.join(output, logs[1].file), "utf8"),
      "workspace original error"
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("shell readiness requires the retained actual pane independently of candidate selector", () => {
  const observed = {
    restored: true,
    selectorPresent: false,
    panePanelIds: [],
    layout: [{ columns: "0", panels: "", residentColumns: "" }],
    panelIds: [marker.id],
  };
  assert.equal(phasePaneReady(observed, marker), false);
  observed.layout = [{ columns: "1", panels: marker.id, residentColumns: "col1" }];
  assert.equal(phasePaneReady(observed, marker), false);
  observed.panePanelIds = [marker.id];
  assert.equal(phasePaneReady(observed, marker), true);
  observed.selectorPresent = true;
  assert.equal(phasePaneReady(observed, marker), true);
  observed.layout[0].panels = "another panel";
  assert.equal(phasePaneReady(observed, marker), false);
});

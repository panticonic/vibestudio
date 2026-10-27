#!/usr/bin/env node
/** Exercise the built product A -> B -> unchanged B using one private profile.
 * Run under an existing display (or xvfb-run). Only the two supplied canonical
 * template collections differ; the runner never changes installed workspace files.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";
import { sweep, awaitRetirement } from "@vibestudio/shared/ownership";
import { ledgerDirOf, listLedgers } from "@vibestudio/shared/ownershipLedger";
import { getSharedDerivedDataPath } from "@vibestudio/env-paths";
import { ownedEntry, retireOnAbort } from "./lib/owned-entry.mjs";
import { runWithOwnedCleanup, runOwnedCleanupSteps } from "./lib/owned-cleanup.mjs";
import { joinChildProcess } from "./lib/join-child-process.mjs";
import { inspectPresentedDesktopDocuments } from "./lib/presented-desktop-documents.mjs";
import { nativeRpcInRenderer } from "./lib/desktop-shared-revocation.mjs";
import { deserializeRpcFailure } from "@vibestudio/rpc";
import { tsImport } from "tsx/esm/api";
const { CentralDataManager } = await tsImport("@vibestudio/shared/centralData", import.meta.url);
import { startEphemeralLinuxSecretService } from "./lib/linux-secret-service.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOG_LIMIT = 256 * 1024;
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

export function parseOptions(argv) {
  const options = { timeoutMs: 1_800_000, selector: "[data-pane-titlebar]" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") {
      options.help = true;
      continue;
    }
    const key = {
      "--before": "before",
      "--after": "after",
      "--out-dir": "outDir",
      "--expect-selector": "selector",
      "--timeout-ms": "timeoutMs",
    }[arg];
    if (!key || !argv[index + 1] || argv[index + 1].startsWith("--"))
      throw new Error(`Unknown or incomplete option: ${arg}`);
    options[key] = argv[++index];
  }
  options.timeoutMs = Number(options.timeoutMs);
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1)
    throw new Error("--timeout-ms must be a positive diagnostic deadline");
  if (!options.help && (!options.before || !options.after))
    throw new Error("Supply --before and --after canonical template collection roots");
  if (options.before) options.before = fs.realpathSync(options.before);
  if (options.after) options.after = fs.realpathSync(options.after);
  if (options.outDir) options.outDir = path.resolve(options.outDir);
  return options;
}

/** Receipt lines are the actual startup operation, not a synthetic success marker. */
export function readUpdateReceipts(text) {
  return text
    .split(/\r?\n/u)
    .filter((line) => line.includes("[WorkspaceUpdates]"))
    .map((line) => {
      const payload = line
        .slice(line.indexOf("[WorkspaceUpdates]") + "[WorkspaceUpdates]".length)
        .trim();
      let receipt;
      try {
        receipt = JSON.parse(payload);
      } catch {
        throw new Error(`Malformed workspace update receipt: ${payload.slice(0, 300)}`);
      }
      if (
        !receipt ||
        typeof receipt !== "object" ||
        typeof receipt.workspaceId !== "string" ||
        typeof receipt.status !== "string"
      )
        throw new Error("Workspace update receipt has no workspaceId/status");
      return receipt;
    });
}

/** Keep the original failure graph across test/launcher boundaries in bounded evidence. */
export function describeFailure(failure) {
  const seen = new Set();
  let remaining = 64;
  const text = (value) => String(value).slice(0, 8192);
  const visit = (error, depth) => {
    if (error === null || typeof error !== "object") return { message: text(error) };
    if (seen.has(error)) return { message: "Failure already recorded (shared or cyclic cause)" };
    if (remaining-- <= 0) return { message: "Additional failure nodes omitted" };
    seen.add(error);
    const node = {
      name: text(error.name ?? error.constructor?.name ?? "Error"),
      message: text(error.message ?? error),
      ...(typeof error.stack === "string" ? { stack: text(error.stack) } : {}),
    };
    for (const key of ["code", "errno", "exitCode", "signal", "detail", "diagnostics", "logPath"])
      if (["string", "number", "boolean"].includes(typeof error[key]))
        node[key] = typeof error[key] === "string" ? text(error[key]) : error[key];
    if (depth === 0) {
      if (error.cause !== undefined || Array.isArray(error.errors)) node.truncated = true;
      return node;
    }
    if (error.cause !== undefined) node.cause = visit(error.cause, depth - 1);
    if (Array.isArray(error.errors)) {
      node.errors = error.errors.slice(0, 16).map((child) => visit(child, depth - 1));
      if (error.errors.length > 16) node.omittedErrors = error.errors.length - 16;
    }
    return node;
  };
  return visit(failure, 8);
}

/** Only the product's presented terminal failure header fails the run. */
export function startupFailure(snapshot) {
  const header = snapshot?.header;
  if (header?.tone !== "error" || header.eyebrow !== "Cannot start") return null;
  return Object.assign(new Error(header.title || "Product workspace startup failed"), {
    name: "ProductStartupFailure",
    code: "EPRODUCTSTARTUP",
    ...(header.copy ? { detail: header.copy } : {}),
    ...(snapshot.diagnostics ? { diagnostics: snapshot.diagnostics } : {}),
    ...(snapshot.logPath ? { logPath: snapshot.logPath } : {}),
  });
}

/** Serialized to the real Electron main inspector; reads only presented bootstrap documents. */
async function readPresentedStartupStates({ webContents }, documents) {
  const readBootstrap = async () => {
    if (!document.querySelector("main[data-bootstrap-mode]")) return null;
    return {
      diagnostics: document.querySelector(".startup-diagnostics pre")?.textContent,
      logPath: document.querySelector(".log-path code")?.textContent,
      header: {
        tone: document.querySelector(".launch-header")?.getAttribute("data-tone"),
        eyebrow: document.querySelector("#bootstrap-eyebrow")?.textContent,
        title: document.querySelector("#bootstrap-title")?.textContent,
        copy: document.querySelector("#launch-copy")?.textContent,
      },
    };
  };
  const snapshots = [];
  for (const presented of documents) {
    const contents = webContents.fromId(presented.id);
    if (
      !contents ||
      contents.isDestroyed() ||
      contents.isLoadingMainFrame() ||
      contents.getURL() !== presented.url
    )
      continue;
    try {
      const state = await contents.executeJavaScript(`(${readBootstrap.toString()})()`, true);
      if (state) snapshots.push({ id: presented.id, url: presented.url, ...state });
    } catch (error) {
      // The original document can disappear while the approved client is delivered.
      if (
        contents.isDestroyed() ||
        contents.isLoadingMainFrame() ||
        contents.getURL() !== presented.url
      )
        continue;
      throw error;
    }
  }
  return snapshots;
}

function sourcePins(phase) {
  return new Map(
    phase.workspaces.flatMap((workspace) =>
      workspace.installed.map(({ pin }) => [`${workspace.workspaceId}\n${pin.url}`, pin.commit])
    )
  );
}

/** Author one ordinary local change to an installed repository before upgrading it. */
async function publishLocalSourceMarker(inspector, document, workspaceId, runId) {
  const destination = { kind: "workspace", workspaceId };
  const call = (method, args) => inspector.rpc(document, destination, method, args);
  const { contextId } = await call("runtime.createContext", [
    { contextId: `upgrade-local-${randomUUID()}` },
  ]);
  const status = await call("vcs.status", [{ contextId }]);
  const repoPath = "clients/desktop-browser";
  const repository = await call("vcs.resolveRepository", [{ state: status.workingHead, repoPath }]);
  assert(repository, "The installed System desktop client repository is missing");
  const marker = {
    workspaceId,
    contextId,
    repoPath,
    path: "upgrade-retention.txt",
    text: `Local source retained through product upgrade ${runId}\n`,
  };
  const edited = await call("vcs.edit", [
    {
      commandId: `${contextId}:edit`,
      contextId,
      expectedWorkingHead: status.workingHead,
      intentSummary: "Retain a local source change across the product workspace update",
      changes: [
        {
          kind: "file-create",
          repositoryId: repository.repositoryId,
          path: marker.path,
          content: { kind: "text", text: marker.text },
          mode: 0o644,
        },
      ],
    },
  ]);
  const committed = await call("vcs.commit", [
    {
      commandId: `${contextId}:commit`,
      contextId,
      expectedWorkingHead: edited.workingHead,
      message: "Local source marker for product upgrade retention",
    },
  ]);
  const published = await call("vcs.push", [
    {
      commandId: `${contextId}:push`,
      contextId,
      expectedCommittedEventId: committed.event.eventId,
      expectedMainEventId: status.mainEventId,
    },
  ]);
  const file = await readLocalSourceMarker(inspector, document, marker);
  assert.equal(file?.content?.kind, "text", "Published local source marker is not text");
  assert.equal(file.content.text, marker.text, "Local source publication changed its exact text");
  return { ...marker, fileId: file.fileId, publishedMainEventId: published.mainEventId };
}

/** Read immutable protected-main source through the ordinary semantic VCS boundary. */
async function readLocalSourceMarker(inspector, document, marker) {
  const destination = { kind: "workspace", workspaceId: marker.workspaceId };
  const call = (method, args) => inspector.rpc(document, destination, method, args);
  const state = await call("vcs.mainState", []);
  const repository = await call("vcs.resolveRepository", [{ state, repoPath: marker.repoPath }]);
  if (!repository) return null;
  const file = await call("vcs.readFile", [
    { state, repositoryId: repository.repositoryId, file: { kind: "path", path: marker.path } },
  ]);
  return (
    file && {
      fileId: file.fileId,
      repositoryId: file.repositoryId,
      path: file.path,
      contentHash: file.contentHash,
      content: file.content,
      mainEventId: state.eventId,
    }
  );
}

/** Assert observed state, including an actual changed installed source coordinate. */
export function verifyUpgrade(before, after, again, marker) {
  const ids = (phase) => phase.workspaces.map(({ workspaceId }) => workspaceId).sort();
  assert.deepEqual(ids(after), ids(before), "Upgrade replaced the workspace identities");
  assert.deepEqual(ids(again), ids(before), "Unchanged restart replaced the workspace identities");
  for (const [label, phase] of [
    ["before", before],
    ["after", after],
    ["restart", again],
  ]) {
    assert(phase.localSource, `${label}: retained local source file is absent`);
    assert.equal(
      phase.localSource.fileId,
      marker.localSource.fileId,
      `${label}: local source file identity changed`
    );
    assert.deepEqual(
      phase.localSource.content,
      { kind: "text", text: marker.localSource.text },
      `${label}: local source bytes changed`
    );
    assert.equal(
      phase.localSource.contentHash,
      before.localSource.contentHash,
      `${label}: local source content hash changed`
    );
    assert(phase.panelIds.includes(marker.id), `${label}: retained marker panel is absent`);
    assert.equal(
      phase.markerPresentation?.id,
      marker.id,
      `${label}: marker presentation identity changed`
    );
    // A panel's displayed title belongs to its running page. Retention checks
    // the authored slot state, which must survive independent of page loading.
    assert.deepEqual(
      phase.markerPresentation?.stateArgs,
      marker.stateArgs,
      `${label}: authored panel state changed`
    );
    assert.equal(phase.markerPresentation?.source, "about/new", `${label}: marker source changed`);
    assert.equal(
      phase.markerPresentation?.contextId,
      before.markerPresentation?.contextId,
      `${label}: marker context changed`
    );
  }
  const oldPins = sourcePins(before),
    nextPins = sourcePins(after),
    finalPins = sourcePins(again);
  const changed = [...oldPins].filter(([key, commit]) => nextPins.get(key) !== commit);
  assert(changed.length > 0, "The candidate release did not change any installed workspace source");
  assert.deepEqual(finalPins, nextPins, "Unchanged restart changed installed source pins");
  const published = after.receipts.filter((receipt) => receipt.status === "published");
  assert(published.length > 0, "Candidate startup reported no published workspace upgrade");
  assert(
    !after.receipts.some((receipt) => receipt.status === "conflicts"),
    "Upgrade left a staged conflict"
  );
  assert(
    !again.receipts.some((receipt) => receipt.status === "published"),
    "Unchanged restart published another upgrade"
  );
  assert(
    again.receipts.some((receipt) => receipt.status === "current"),
    "Unchanged restart did not confirm installed sources are current"
  );
  return changed.map(([key, fromCommit]) => {
    const [workspaceId, sourceUrl] = key.split("\n");
    const toCommit = nextPins.get(key);
    assert(
      published.some(
        (receipt) =>
          receipt.workspaceId === workspaceId &&
          receipt.sourceUrl === sourceUrl &&
          receipt.fromCommit === fromCommit &&
          receipt.toCommit === toCommit
      ),
      `Changed source has no matching publication receipt: ${sourceUrl}`
    );
    return { workspaceId, sourceUrl, fromCommit, toCommit };
  });
}

/** Retain only bounded logs from this run's private profile before retiring it. */
export function retainProfileFailureLogs(profileDir, outDir) {
  const candidates = [];
  const addLogs = (directory) => {
    if (!fs.existsSync(directory)) return;
    if (!fs.lstatSync(directory).isDirectory()) return;
    for (const entry of fs
      .readdirSync(directory, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name)))
      if (entry.isFile() && entry.name.endsWith(".log"))
        candidates.push(path.join(directory, entry.name));
  };
  addLogs(path.join(profileDir, "logs"));
  const workspaces = path.join(profileDir, "workspaces");
  if (fs.existsSync(workspaces))
    for (const workspace of fs
      .readdirSync(workspaces, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name)))
      if (workspace.isDirectory()) addLogs(path.join(workspaces, workspace.name, "state", "logs"));
  const retained = [];
  for (const source of candidates.slice(0, 12)) {
    const descriptor = fs.openSync(source, "r");
    try {
      const length = fs.fstatSync(descriptor).size;
      const bytes = Buffer.alloc(Math.min(length, LOG_LIMIT));
      fs.readSync(descriptor, bytes, 0, bytes.length, Math.max(0, length - bytes.length));
      const relative = path.relative(profileDir, source);
      const target = `failure-${relative.split(path.sep).join("_")}`;
      fs.writeFileSync(path.join(outDir, target), bytes, { mode: 0o600 });
      retained.push({
        source: relative,
        file: target,
        bytes: bytes.length,
        truncated: length > bytes.length,
      });
    } finally {
      fs.closeSync(descriptor);
    }
  }
  return retained;
}

function boundedLog(file) {
  let tail = "",
    pending = "";
  const endpoints = {};
  const receipts = [];
  return {
    endpoints,
    receipts,
    append(chunk) {
      const text = chunk.toString();
      tail = (tail + text).slice(-LOG_LIMIT);
      fs.writeFileSync(file, tail, { mode: 0o600 });
      pending += text;
      for (;;) {
        const end = pending.indexOf("\n");
        if (end < 0) break;
        const line = pending.slice(0, end);
        pending = pending.slice(end + 1);
        const url = line.match(/(?:DevTools|Debugger) listening on (ws:\/\/\S+)/u)?.[1];
        if (url) endpoints[url.includes("/devtools/browser/") ? "browser" : "main"] = url;
        receipts.push(...readUpdateReceipts(line));
      }
      if (pending.length > LOG_LIMIT) pending = pending.slice(-LOG_LIMIT);
    },
  };
}

/** Nested launchers own independent reapers inside the private profile. The
 * launcher groups are already joined; join their reapers before outer scratch
 * retirement can remove a directory those reapers are still changing.
 */
export async function retireNestedProfile(profileDir) {
  const dir = ledgerDirOf(profileDir);
  await runOwnedCleanupSteps(
    [
      () => sweep(dir),
      async () => {
        const outcomes = await Promise.allSettled(
          listLedgers(dir).map(({ ledger }) =>
            awaitRetirement(dir, ledger.id, { token: ledger.token })
          )
        );
        const failures = outcomes.flatMap((outcome) =>
          outcome.status === "rejected" ? [outcome.reason] : []
        );
        if (failures.length)
          throw new AggregateError(failures, "Nested product reapers failed to retire");
      },
    ],
    "Private product profile ownership retirement failed"
  );
}

/** Read one exact, currently presented document without attaching every hidden native view. */
async function readPresentedRenderer({ webContents }, request) {
  const contents = webContents.fromId(request.document.id);
  if (
    !contents ||
    contents.isDestroyed() ||
    contents.isLoadingMainFrame() ||
    contents.getURL() !== request.document.url
  )
    throw new Error("The addressed presented desktop document was retired");
  return contents.executeJavaScript(`(${request.read})(${JSON.stringify(request.input)})`, true);
}

/** A smoke run only decides its own exact sequential authoring requests. */
export function markerApprovalMatches(approval, operation, callerId) {
  const split = operation.method.indexOf(".");
  return (
    approval?.kind === "capability" &&
    approval.callerKind === "client" &&
    approval.callerId === callerId &&
    approval.snapshot?.service === operation.method.slice(0, split) &&
    approval.snapshot?.method === operation.method.slice(split + 1) &&
    approval.lifecycle?.state !== "preparing" &&
    approval.allowedDecisions?.includes("once") === true
  );
}

/** Serialize into the real UI; only the exact reviewed card's once button is actionable. */
function clickApprovalOnce(approvalId) {
  const visible = (element) =>
    element && element.getClientRects().length > 0 && !element.closest("[hidden]");
  const cards = [...document.querySelectorAll("[data-approval-id]")].filter(visible);
  const card = cards.find((element) => element.getAttribute("data-approval-id") === approvalId);
  const decision = card?.querySelector('[data-approval-decision="once"]');
  if (visible(decision) && !decision.disabled) {
    decision.click();
    return "decided";
  }
  if (cards.length) {
    const next = [...document.querySelectorAll('button[aria-label="Next approval"]')].find(visible);
    if (next && !next.disabled) {
      next.click();
      return "advanced";
    }
  } else {
    const pill = [...document.querySelectorAll("[data-approval-pill]")].find(visible);
    if (pill) {
      pill.click();
      return "presented";
    }
  }
  return null;
}

/** Standard Node inspector connection to the real Electron main process. */
async function mainInspector(url, signal, recordOperation, retireProduct) {
  signal.throwIfAborted();
  const socket = new WebSocket(url);
  const pending = new Map();
  let sequence = 0;
  const closed = new Promise((resolve) => socket.once("close", resolve));
  const fail = (error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  socket.on("message", (bytes) => {
    const message = JSON.parse(Buffer.from(bytes).toString());
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  socket.on("error", fail);
  socket.once("close", () => fail(new Error("Electron main inspector disconnected")));
  const stop = () => socket.terminate();
  signal.addEventListener("abort", stop, { once: true });
  try {
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
      socket.once("close", () => reject(new Error("Electron inspector closed before connecting")));
    });
  } catch (error) {
    signal.removeEventListener("abort", stop);
    socket.terminate();
    await closed;
    throw error;
  }
  const call = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }), (error) => {
        if (error) {
          pending.delete(id);
          reject(error);
        }
      });
    });
  const evaluate = async (read, request) => {
    const expression = `(${read.toString()})(process.mainModule.require("electron"), ${JSON.stringify(request)})`;
    const result = await call("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails)
      throw new Error(
        result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
      );
    return result.result?.value;
  };
  const documents = () => evaluate(inspectPresentedDesktopDocuments, { kind: "documents" });
  const read = async (document, reader, input) => {
    if (
      !(await documents()).some(
        (candidate) => candidate.id === document.id && candidate.url === document.url
      )
    )
      throw new Error("The addressed desktop document is no longer presented");
    return evaluate(readPresentedRenderer, { document, read: reader.toString(), input });
  };
  const rawRpc = async (document, destination, method, args) => {
    const outcome = await read(document, nativeRpcInRenderer, { destination, method, args });
    if ("failure" in outcome) throw deserializeRpcFailure(outcome.failure);
    return outcome.result;
  };
  const inspector = {
    inspect: (request) => evaluate(inspectPresentedDesktopDocuments, request),
    documents,
    read,
    async startupSnapshots() {
      return evaluate(readPresentedStartupStates, await documents());
    },
    async rpc(document, destination, method, args) {
      const operation = {
        id: randomUUID(),
        method,
        destination,
        status: "pending",
        startedAt: new Date().toISOString(),
      };
      recordOperation(operation);
      let outcome;
      const request = rawRpc(document, destination, method, args);
      void request.then(
        (result) => {
          outcome = { result };
        },
        (error) => {
          outcome = { error };
        }
      );
      try {
        if (destination.kind === "workspace") {
          const callerId = await read(
            document,
            () => globalThis.__vibestudioTransport?.identity?.runtimeId
          );
          while (!outcome) {
            signal.throwIfAborted();
            const queue = await rawRpc(document, destination, "shellApproval.listPending", []);
            const matching = queue.filter((approval) =>
              markerApprovalMatches(approval, operation, callerId)
            );
            for (const approval of matching)
              for (const presented of await documents()) {
                const decided = await read(presented, clickApprovalOnce, approval.approvalId);
                if (decided === "decided") {
                  operation.approvalId = approval.approvalId;
                  recordOperation(operation);
                  break;
                }
              }
            if (!outcome) await delay(100, undefined, { signal });
          }
        }
        const result = await request;
        operation.status = "completed";
        return result;
      } catch (failure) {
        if (!outcome) {
          // This is an observation failure, not a response from the operation.
          // End its actual owning product lifecycle, then join the original
          // invocation. A lost observer must never abandon a live source write.
          operation.status = "observation-failed";
          operation.observationError = describeFailure(failure);
          const failures = [failure];
          try {
            socket.terminate();
            await closed;
            await retireProduct();
          } catch (retirementFailure) {
            failures.push(retirementFailure);
          }
          await request.catch((invocationFailure) => {
            operation.invocationTermination = describeFailure(invocationFailure);
          });
          if (signal.aborted) failures.unshift(signal.reason);
          throw new AggregateError(
            failures,
            `Observation of ${method} failed; its product lifecycle and invocation were joined`,
            { cause: failures[0] }
          );
        }
        operation.status = outcome.error ? "failed" : "observation-failed";
        const error =
          outcome.error && outcome.error !== failure
            ? new AggregateError(
                [outcome.error, failure],
                `RPC ${method} failed while its approval was observed`,
                { cause: outcome.error }
              )
            : failure;
        operation.error = describeFailure(error);
        throw error;
      } finally {
        operation.finishedAt = new Date().toISOString();
        recordOperation(operation);
      }
    },
    async capture(document) {
      const image = await evaluate(async ({ webContents }, selected) => {
        const contents = webContents.fromId(selected.id);
        if (!contents || contents.isDestroyed() || contents.getURL() !== selected.url)
          throw new Error("Presented desktop was retired before capture");
        return (await contents.capturePage()).toPNG().toString("base64");
      }, document);
      return Buffer.from(image, "base64");
    },
    async close() {
      signal.removeEventListener("abort", stop);
      socket.close();
      await closed;
    },
  };
  return inspector;
}

async function observeUntil(read, label, signal) {
  for (;;) {
    signal.throwIfAborted();
    let result;
    try {
      result = await read();
    } catch (cause) {
      throw new Error(label, { cause });
    }
    if (result) return result;
    // Test observation cadence only. The run's diagnostic deadline cancels and
    // joins every owned workload; elapsed time is never product recovery policy.
    await delay(100, undefined, { signal });
  }
}

async function productCommand(ownership, signal, env, args, label, outDir, observe) {
  const log = boundedLog(path.join(outDir, `${label}.log`));
  const owned = ownership.spawn(pnpm, args, {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    kill: "graceful",
    label,
  });
  retireOnAbort(ownership, signal, owned);
  const { child } = owned;
  let logFailure;
  const append = (chunk) => {
    try {
      log.append(chunk);
    } catch (error) {
      logFailure ??= error;
      void ownership.scope.track(owned.retire());
    }
  };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  const exited = joinChildProcess(child);
  let exit;
  void exited.then((result) => {
    exit = result;
  });
  await owned.registered;
  const check = () => {
    signal.throwIfAborted();
    if (logFailure) throw logFailure;
    if (exit)
      throw new Error(
        `${label} exited before completing observation (${exit.code ?? exit.signal}); see ${label}.log`
      );
  };
  return runWithOwnedCleanup(
    async () => {
      if (observe) return await observe(log, check, () => owned.retire());
      const result = await exited;
      if (logFailure) throw logFailure;
      signal.throwIfAborted();
      if (result.error) throw result.error;
      if (result.code !== 0)
        throw new Error(`${label} failed (${result.code ?? result.signal}); see ${label}.log`);
    },
    () =>
      runOwnedCleanupSteps(
        [() => owned.retire(), () => exited],
        "Product command retirement failed"
      ),
    "Product command and retirement failed"
  );
}

/** A restored empty layout is valid shell state; wait for the addressed pane itself. */
export function phasePaneReady(observed, marker) {
  if (!observed.restored) return false;
  const visible = new Set(
    observed.layout.flatMap((layout) =>
      Number(layout.columns) > 0 && layout.residentColumns
        ? (layout.panels ?? "").split(",").filter(Boolean)
        : []
    )
  );
  return marker
    ? visible.has(marker.id) && observed.panePanelIds.includes(marker.id)
    : observed.panePanelIds.some((id) => visible.has(id));
}

async function collectPhase(
  inspector,
  signal,
  selector,
  marker,
  requireSelector,
  check,
  recordMismatch
) {
  return observeUntil(
    async () => {
      check();
      for (const snapshot of await inspector.startupSnapshots()) {
        const failure = startupFailure(snapshot);
        if (failure) throw failure;
      }
      const snapshots = await inspector.inspect({ kind: "snapshots" });
      const review = snapshots.find((snapshot) => snapshot.launchGateReview?.actionable);
      if (review) {
        await inspector.inspect({
          kind: "start-launch-gate",
          id: review.id,
          url: review.url,
          html: review.launchGateReview.html,
        });
        return null;
      }
      for (const labelSource of [
        "^Start Vibestudio$",
        "^Create and launch$",
        "^Keep automatic reports off$",
        "^Add to workspace$",
      ])
        if (await inspector.inspect({ kind: "click", labelSource })) return null;
      for (const document of await inspector.documents()) {
        if (!document.url.startsWith("vs-client:") || document.url.includes("overlaySurface="))
          continue;
        const observed = await inspector.read(
          document,
          (expectedSelector) => ({
            restored: Boolean(
              globalThis.document.querySelector('[data-shell-layout-restored="true"]')
            ),
            selectorPresent: Boolean(globalThis.document.querySelector(expectedSelector)),
            panePanelIds: [...globalThis.document.querySelectorAll("[data-pane-panel-id]")].map(
              (entry) => entry.getAttribute("data-pane-panel-id")
            ),
            panelIds: [
              ...new Set(
                [...globalThis.document.querySelectorAll("[data-panel-id]")].map((entry) =>
                  entry.getAttribute("data-panel-id")
                )
              ),
            ],
            panelTitles: [...globalThis.document.querySelectorAll("[data-panel-id]")].map(
              (entry) => entry.getAttribute("title") ?? entry.textContent?.trim()
            ),
            layout: [...globalThis.document.querySelectorAll("[data-shell-layout-restored]")].map(
              (entry) => ({
                columns: entry.getAttribute("data-shell-layout-columns"),
                panels: entry.getAttribute("data-shell-layout-visible-panels"),
                residentColumns: entry.getAttribute("data-shell-layout-resident-columns"),
              })
            ),
          }),
          selector
        );
        if (!phasePaneReady(observed, marker)) continue;
        if (observed.selectorPresent !== requireSelector)
          await recordMismatch(
            { document, observed, selector, expected: requireSelector },
            await inspector.capture(document)
          );
        assert.equal(
          observed.selectorPresent,
          requireSelector,
          requireSelector
            ? `Updated desktop did not present ${selector}`
            : `Baseline already presents candidate selector ${selector}`
        );
        const workspaces = await inspector.rpc(
          document,
          { kind: "hub" },
          "hubControl.listWorkspaces",
          []
        );
        if (
          !workspaces.some((workspace) => workspace.privateRole === "system") ||
          !workspaces.some((workspace) => workspace.privateRole === "personal")
        )
          continue;
        if (marker && !observed.panelIds.includes(marker.id)) continue;
        let markerPresentation;
        if (marker) {
          const value = await inspector.rpc(
            document,
            { kind: "workspace", workspaceId: marker.workspaceId },
            "view.getPresentation",
            [marker.id]
          );
          if (!value) continue;
          markerPresentation = {
            id: value.id,
            title: value.title,
            source: value.snapshot.source,
            contextId: value.snapshot.contextId,
            stateArgs: value.snapshot.stateArgs,
          };
        }
        const localSource = marker?.localSource
          ? await readLocalSourceMarker(inspector, document, marker.localSource)
          : undefined;
        const installed = [];
        for (const workspace of workspaces)
          installed.push({
            workspaceId: workspace.workspaceId,
            privateRole: workspace.privateRole,
            installed: await inspector.rpc(
              document,
              { kind: "workspace", workspaceId: workspace.workspaceId },
              "extensions.invoke",
              ["templates", "installed", []]
            ),
          });
        return {
          ...observed,
          markerPresentation,
          localSource,
          workspaces: installed,
          shellUrl: document.url.split(/[?#]/u)[0],
          document,
        };
      }
      return null;
    },
    "waiting for the actual product shell",
    signal
  );
}

export async function runProductUpgradeSmoke(options) {
  const runId = `${new Date().toISOString().replace(/[-:.]/gu, "")}-${randomUUID().slice(0, 8)}`;
  const outDir =
    options.outDir ?? path.join(repoRoot, "test-results", "product-upgrade-smoke", runId);
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const report = {
    version: 1,
    runId,
    before: options.before,
    after: options.after,
    phases: {},
    result: "running",
  };
  const save = () =>
    fs.writeFileSync(path.join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, {
      mode: 0o600,
    });
  save();
  // Inherit the existing exact, content-addressed cache; this run does not own
  // it. All mutable profile/workspace/browser state is private and persistent
  // only across the launches in this operation.
  const sharedCache = getSharedDerivedDataPath();
  try {
    await ownedEntry(
      async ({ ownership, scratchRoot, signal: ownerSignal }) => {
        const controller = new AbortController();
        const forwardAbort = () => controller.abort(ownerSignal.reason);
        ownerSignal.addEventListener("abort", forwardAbort, { once: true });
        if (ownerSignal.aborted) forwardAbort();
        const diagnostic = setTimeout(
          () =>
            controller.abort(
              new Error(
                `Product upgrade smoke diagnostic deadline reached (${options.timeoutMs}ms)`
              )
            ),
          options.timeoutMs
        );
        const signal = controller.signal;
        let desktopEnvironment;
        const privateProfile = path.join(scratchRoot, "profile");
        await runWithOwnedCleanup(
          async () => {
            try {
              // This private fixture remembers the ordinary "Quit and stop" choice,
              // so graceful teardown does not wait at the native quit dialog.
              const centralData = new CentralDataManager({
                databasePath: path.join(privateProfile, "server-auth", "identity.db"),
              });
              try {
                centralData.setKeepServerOnQuit(false);
              } finally {
                centralData.close();
              }
              desktopEnvironment = await startEphemeralLinuxSecretService(ownership, scratchRoot, {
                signal,
              });
              const commonEnv = {
                ...process.env,
                ...desktopEnvironment.env,
                VIBESTUDIO_PROFILE_ROOT: privateProfile,
                VIBESTUDIO_SHARED_DERIVED_CACHE_DIR: sharedCache,
                XDG_CONFIG_HOME: path.join(scratchRoot, "xdg"),
              };
              delete commonEnv.VIBESTUDIO_INSTANCE_ROOT;
              delete commonEnv.VIBESTUDIO_INSTANCE;
              delete commonEnv.VIBESTUDIO_TEST_MODE;
              delete commonEnv.VIBESTUDIO_WORKSPACE_RELEASE_ROOT;
              // xvfb-run owns an X11 display. A Wayland socket inherited from
              // the invoking desktop belongs to another runtime/session.
              const usesX11 = process.platform === "linux" && Boolean(commonEnv.DISPLAY);
              if (usesX11) delete commonEnv.WAYLAND_DISPLAY;
              let marker;
              const launch = async (name, root, requireSelector) =>
                productCommand(
                  ownership,
                  signal,
                  { ...commonEnv, VIBESTUDIO_TEMPLATE_CHECKOUTS: root },
                  [
                    "start",
                    "--inspect=0",
                    "--remote-debugging-port=0",
                    ...(usesX11 ? ["--ozone-platform=x11"] : []),
                    `--user-data-dir=${path.join(scratchRoot, "chromium")}`,
                    ...desktopEnvironment.electronArgs,
                  ],
                  name,
                  outDir,
                  async (log, check, retireProduct) => {
                    const endpoint = await observeUntil(
                      () => {
                        check();
                        return log.endpoints.main ?? null;
                      },
                      "waiting for product main inspector",
                      signal
                    );
                    const inspector = await mainInspector(
                      endpoint,
                      signal,
                      (operation) => {
                        report.operations ??= [];
                        const index = report.operations.findIndex(
                          (entry) => entry.id === operation.id
                        );
                        const entry = structuredClone({ phase: name, ...operation });
                        if (index < 0) report.operations.push(entry);
                        else report.operations[index] = entry;
                        report.operations = report.operations.slice(-100);
                        save();
                      },
                      retireProduct
                    );
                    const checkOperation = () => {
                      check();
                      const conflict = log.receipts.find(
                        (receipt) => receipt.status === "conflicts"
                      );
                      if (conflict)
                        throw new Error(`Workspace upgrade conflict: ${JSON.stringify(conflict)}`);
                    };
                    const recordMismatch = async (observation, png) => {
                      report.failedObservation = { phase: name, ...observation };
                      fs.writeFileSync(path.join(outDir, `${name}-mismatch.png`), png, {
                        mode: 0o600,
                      });
                      save();
                    };
                    return runWithOwnedCleanup(
                      async () => {
                        let phase = await collectPhase(
                          inspector,
                          signal,
                          options.selector,
                          marker,
                          requireSelector,
                          checkOperation,
                          recordMismatch
                        );
                        if (!marker) {
                          const personal = phase.workspaces.find(
                            (workspace) => workspace.privateRole === "personal"
                          );
                          const title = `Upgrade retention ${runId}`;
                          const stateArgs = { upgradeRetention: runId };
                          const created = await inspector.rpc(
                            phase.document,
                            { kind: "workspace", workspaceId: personal.workspaceId },
                            "view.createPanel",
                            [
                              null,
                              "about/new",
                              { title, slug: `upgrade-${randomUUID()}`, focus: true, stateArgs },
                            ]
                          );
                          const system = phase.workspaces.find(
                            (workspace) => workspace.privateRole === "system"
                          );
                          marker = {
                            id: created.id,
                            title,
                            stateArgs,
                            workspaceId: personal.workspaceId,
                          };
                          report.marker = marker;
                          save();
                          await inspector.inspect({ kind: "click", labelSource: "^Open System$" });
                          marker.localSource = await publishLocalSourceMarker(
                            inspector,
                            phase.document,
                            system.workspaceId,
                            runId
                          );
                          save();
                          phase = await collectPhase(
                            inspector,
                            signal,
                            options.selector,
                            marker,
                            requireSelector,
                            checkOperation,
                            recordMismatch
                          );
                        }
                        const { document, ...observed } = phase;
                        fs.writeFileSync(
                          path.join(outDir, `${name}.png`),
                          await inspector.capture(document),
                          { mode: 0o600 }
                        );
                        observed.receipts = [...log.receipts];
                        report.phases[name] = observed;
                        save();
                        return observed;
                      },
                      () => inspector.close(),
                      "Product observation and inspector retirement failed"
                    );
                  }
                );
              await productCommand(
                ownership,
                signal,
                { ...commonEnv, VIBESTUDIO_TEMPLATE_CHECKOUTS: options.before },
                ["build:product"],
                "build-before",
                outDir
              );
              const before = await launch("before", options.before, false);
              await productCommand(
                ownership,
                signal,
                { ...commonEnv, VIBESTUDIO_TEMPLATE_CHECKOUTS: options.after },
                ["build:product"],
                "build-after",
                outDir
              );
              const after = await launch("after", options.after, true);
              const again = await launch("restart", options.after, true);
              report.changedSources = verifyUpgrade(before, after, again, marker);
            } catch (error) {
              try {
                report.failureLogs = retainProfileFailureLogs(privateProfile, outDir);
                save();
              } catch (evidenceError) {
                throw new AggregateError(
                  [error, evidenceError],
                  "Product upgrade failed and profile log retention failed",
                  { cause: error }
                );
              }
              throw error;
            }
          },
          async () => {
            clearTimeout(diagnostic);
            ownerSignal.removeEventListener("abort", forwardAbort);
            await runOwnedCleanupSteps(
              [() => desktopEnvironment?.dispose(), () => retireNestedProfile(privateProfile)],
              "Product helpers and private profile retirement failed"
            );
          },
          "Product upgrade run and helper retirement failed"
        );
      },
      { appRoot: repoRoot, scratchPrefix: "product-upgrade-" }
    );
    report.result = "passed";
    save();
    console.log(`[product-upgrade-smoke] PASS; evidence: ${outDir}`);
    return report;
  } catch (error) {
    report.result = "failed";
    report.error = describeFailure(error);
    save();
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseOptions(process.argv.slice(2));
  if (options.help)
    console.log(
      `Usage: node scripts/product-upgrade-smoke.mjs --before CANONICAL_ROOT_A --after CANONICAL_ROOT_B [--out-dir PATH] [--expect-selector CSS] [--timeout-ms N]\nRuns actual pnpm build:product and pnpm start against one private persistent profile.\nRun under xvfb-run on headless Linux. The diagnostic deadline cancels and joins owned work.\nCaller-supplied source roots are read-only inputs; retained bounded evidence is separate from retired scratch.`
    );
  else await runProductUpgradeSmoke(options);
}

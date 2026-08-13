/**
 * Deliberately expensive, opt-in coverage for the real Git/template boundary.
 *
 * This test does not import a host service or manufacture an in-process Git
 * transport.  Vibestudio is driven exclusively through its published CLI; the
 * only native Git use is authoring the two local fixture repositories.
 *
 * Run with:
 *   VIBESTUDIO_RUN_TEMPLATE_GIT_E2E=1 pnpm vitest run tests/template-git-full-stack.e2e.test.ts
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { canonicalSnapshotDigest, sha256Hex } from "@vibestudio/content-addressing";
import {
  normalizeTemplateGitUrl,
  templateAliasFromUrl,
} from "@vibestudio/workspace/templateCoordinates";
import { SmartGitHttpFixture } from "./support/smartGitHttpFixture.js";

const execFileAsync = promisify(execFile);
const RUN = process.env["VIBESTUDIO_RUN_TEMPLATE_GIT_E2E"] === "1";
const root = path.resolve(import.meta.dirname, "..");
const instance = `template-git-e2e-${randomUUID().slice(0, 8)}`;
const templateAlias = "full-stack-template";
const templateRepoPath = `packages/${templateAlias}`;
const inspectionContextId = "template-git-e2e-inspection";
const gitCredentialLabel = `fixture-git-${instance.slice(-8)}`;
const gitUsername = "vibestudio";
const gitPassword = "fixture-secret";

interface CommandResult<T> {
  stdout: string;
  value: T;
}

let server: ChildProcess | undefined;
let serverOutput = "";

function captureServerOutput(chunk: Buffer): void {
  serverOutput = `${serverOutput}${chunk.toString("utf8")}`.slice(-64 * 1024);
}

function serverDiagnostics(): string {
  return serverOutput.length > 0 ? `\nRecent server output:\n${serverOutput}` : "";
}

function jsonFromOutput<T>(stdout: string): T {
  for (const line of stdout.trim().split(/\r?\n/u).reverse()) {
    try {
      return JSON.parse(line) as T;
    } catch {
      // pnpm's command banner and Node warnings are not result payloads.
    }
  }
  throw new Error(`Expected JSON CLI output, got:\n${stdout}`);
}

async function cli<T>(args: string[], timeout = 180_000): Promise<CommandResult<T>> {
  const result = await execFileAsync("pnpm", ["cli", "--instance", instance, ...args], {
    cwd: root,
    timeout,
    maxBuffer: 10 * 1024 * 1024,
  });
  return { stdout: result.stdout, value: jsonFromOutput<T>(result.stdout) };
}

async function cliWithInput<T>(
  args: string[],
  input: string,
  timeout = 180_000
): Promise<CommandResult<T>> {
  return await new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["cli", "--instance", instance, ...args], {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`CLI command timed out after ${timeout}ms: ${args.join(" ")}`));
    }, timeout);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new Error(
            `Command failed (${code ?? signal ?? "unknown"}): ${args.join(" ")}\n${stdout}${stderr}`
          )
        );
        return;
      }
      try {
        resolve({ stdout, value: jsonFromOutput<T>(stdout) });
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(input);
  });
}

async function cliError(args: string[], timeout = 180_000): Promise<string> {
  try {
    await cli<unknown>(args, timeout);
  } catch (error) {
    const failure = error as {
      stdout?: string;
      stderr?: string;
      message?: string;
    };
    return `${failure.stdout ?? ""}\n${failure.stderr ?? ""}\n${failure.message ?? ""}`;
  }
  throw new Error(`Expected CLI command to fail: ${args.join(" ")}`);
}

async function nativeGit(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, timeout: 30_000 });
}

async function waitForCli(): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 90; attempt += 1) {
    try {
      await cli<unknown>(["agent", "services", "--json"], 10_000);
      return;
    } catch (error) {
      lastError = error;
      if (server?.exitCode !== null && server?.exitCode !== undefined) break;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  throw new Error(
    `Ephemeral server did not become CLI-ready: ${String(lastError)}${serverDiagnostics()}`
  );
}

async function stopServer(): Promise<void> {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  const signalServer = (signal: NodeJS.Signals): void => {
    if (process.platform === "win32" || !server?.pid) {
      server?.kill(signal);
      return;
    }
    try {
      process.kill(-server.pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  signalServer("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (server?.exitCode === null) signalServer("SIGKILL");
      resolve();
    }, 10_000);
    server!.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function approveExactly(cardRef: string): Promise<void> {
  type Approval = {
    approvalId: string;
    kind?: string;
    mode?: "adopt-root" | "install" | "update" | "remove" | "part-changed";
    lifecycle?: { state: "preparing" | "ready" | "failed" | "cancelled"; diagnostics?: string[] };
    allowedDecisions?: string[];
  };
  let card: Approval | undefined;
  for (let attempt = 0; attempt < 1_200; attempt += 1) {
    const pending = await cli<
      Array<{
        approvalId: string;
        kind?: string;
        mode?: "adopt-root" | "install" | "update" | "remove" | "part-changed";
        lifecycle?: {
          state: "preparing" | "ready" | "failed" | "cancelled";
          diagnostics?: string[];
        };
        allowedDecisions?: string[];
      }>
    >(["agent", "call", "shellApproval.listPending", "[]", "--json"]);
    card = pending.value.find((entry) => entry.approvalId === cardRef);
    if (!card) break;
    if (card.lifecycle?.state === "failed" || card.lifecycle?.state === "cancelled") {
      throw new Error(
        `Approval ${cardRef} ${card.lifecycle.state}: ${card.lifecycle.diagnostics?.join("; ") ?? "no diagnostics"}`
      );
    }
    if (card.lifecycle?.state !== "preparing") break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  expect(card).toBeDefined();
  if (card?.kind === "unit-install-review") {
    const decision =
      card.mode === "adopt-root" ? "adopt-root" : card.mode === "update" ? "update" : "install";
    await cli<void>([
      "agent",
      "call",
      "shellApproval.resolveInstallReview",
      JSON.stringify([cardRef, { decision, allowNow: [] }]),
      "--json",
    ]);
    return;
  }
  const decision =
    card?.kind === "userland"
      ? "once"
      : card?.allowedDecisions?.includes("once")
        ? "once"
        : card?.allowedDecisions?.find(
            (candidate) => candidate !== "deny" && candidate !== "dismiss"
          );
  expect(decision, `Approval ${cardRef} did not offer a granting decision`).toBeDefined();
  await cli<void>([
    "agent",
    "call",
    card?.kind === "userland" ? "shellApproval.resolveUserland" : "shellApproval.resolve",
    JSON.stringify([cardRef, decision]),
    "--json",
  ]);
}

async function runWithTemplateApprovals<T>(
  args: string[],
  timeout = 180_000
): Promise<CommandResult<T>> {
  type PendingApproval = {
    approvalId: string;
    kind?: string;
    callerId?: string;
    subject?: { id?: string };
    lifecycle?: { state: "preparing" | "ready" | "failed" | "cancelled" };
  };
  const before = await cli<PendingApproval[]>([
    "agent",
    "call",
    "shellApproval.listPending",
    "[]",
    "--json",
  ]);
  const existing = new Set(before.value.map((entry) => entry.approvalId));
  const handled = new Set<string>();
  const pendingCommand = cli<T>(args, timeout);
  let outcome:
    | { state: "resolved"; value: CommandResult<T> }
    | { state: "rejected"; error: unknown }
    | undefined;
  void pendingCommand.then(
    (value) => {
      outcome = { state: "resolved", value };
    },
    (error: unknown) => {
      outcome = { state: "rejected", error };
    }
  );
  for (let attempt = 0; attempt < Math.ceil(timeout / 250); attempt += 1) {
    if (outcome?.state === "resolved") return outcome.value;
    if (outcome?.state === "rejected") throw outcome.error;
    const pending = await cli<PendingApproval[]>([
      "agent",
      "call",
      "shellApproval.listPending",
      "[]",
      "--json",
    ]);
    const approval = pending.value.find(
      (entry) =>
        !existing.has(entry.approvalId) &&
        !handled.has(entry.approvalId) &&
        entry.lifecycle?.state !== "preparing" &&
        ((entry.kind === "userland" && entry.subject?.id?.startsWith("template-")) ||
          entry.callerId === "@workspace-extensions/template-composer")
    );
    if (approval) {
      handled.add(approval.approvalId);
      await approveExactly(approval.approvalId);
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Template approval workflow did not settle for ${args.join(" ")}`);
}

async function runWithAnyApprovals<T>(operation: () => Promise<T>, timeout = 90_000): Promise<T> {
  const before = await cli<Array<{ approvalId: string }>>([
    "agent",
    "call",
    "shellApproval.listPending",
    "[]",
    "--json",
  ]);
  const existing = new Set(before.value.map(({ approvalId }) => approvalId));
  const pending = operation();
  let outcome: { state: "resolved"; value: T } | { state: "rejected"; error: unknown } | undefined;
  void pending.then(
    (value) => {
      outcome = { state: "resolved", value };
    },
    (error: unknown) => {
      outcome = { state: "rejected", error };
    }
  );
  const handled = new Set<string>();
  for (let attempt = 0; attempt < Math.ceil(timeout / 250); attempt += 1) {
    if (outcome?.state === "resolved") return outcome.value;
    if (outcome?.state === "rejected") throw outcome.error;
    const approvals = await cli<Array<{ approvalId: string }>>([
      "agent",
      "call",
      "shellApproval.listPending",
      "[]",
      "--json",
    ]);
    const approval = approvals.value.find(
      ({ approvalId }) => !existing.has(approvalId) && !handled.has(approvalId)
    );
    if (approval) {
      handled.add(approval.approvalId);
      await approveExactly(approval.approvalId);
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Approval workflow did not settle");
}

async function agentCall<T>(serviceMethod: string, args: unknown[]): Promise<T> {
  return (
    await cliWithInput<T>(
      ["agent", "call", serviceMethod, "--input", "--json"],
      JSON.stringify(args)
    )
  ).value;
}

async function waitForTemplateState(
  alias: string,
  expected: string | null
): Promise<Array<{ alias: string; state: string }>> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const rows = (
      await cli<Array<{ alias: string; state: string }>>(["templates", "status", "--json"])
    ).value;
    const row = rows.find((candidate) => candidate.alias === alias);
    if ((expected === null && !row) || row?.state === expected) return rows;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Template ${alias} did not reach state ${expected ?? "removed"}`);
}

async function status(contextId: string): Promise<{
  workingHead: unknown;
  mainEventId: string;
}> {
  return await agentCall("vcs.status", [{ contextId }]);
}

async function replaceProtectedText(
  repoPath: string,
  filePath: string,
  text: string
): Promise<string> {
  const contextId = `template-git-e2e-${randomUUID()}`;
  await agentCall("runtime.createContext", [{ contextId }]);
  const before = await status(contextId);
  const repository = await agentCall<{ repositoryId: string } | null>("vcs.resolveRepository", [
    { state: before.workingHead, repoPath },
  ]);
  if (!repository) throw new Error(`Missing semantic repository ${repoPath}`);
  const file = await agentCall<{
    fileId: string;
    content: { kind: "text"; text: string } | { kind: "bytes"; base64: string };
  } | null>("vcs.readFile", [
    {
      state: before.workingHead,
      repositoryId: repository.repositoryId,
      file: { kind: "path", path: filePath },
    },
  ]);
  if (!file || file.content.kind !== "text") {
    throw new Error(`Expected managed text file ${repoPath}/${filePath}`);
  }
  const edited = await agentCall<{ workingHead: unknown }>("vcs.edit", [
    {
      commandId: `template-e2e-edit:${randomUUID()}`,
      contextId,
      expectedWorkingHead: before.workingHead,
      changes: [
        {
          kind: "text-edit",
          repositoryId: repository.repositoryId,
          fileId: file.fileId,
          edits: [{ start: 0, end: file.content.text.length, text }],
        },
      ],
    },
  ]);
  const committed = await agentCall<{ event: { kind: "event"; eventId: string } }>("vcs.commit", [
    {
      commandId: `template-e2e-commit:${randomUUID()}`,
      contextId,
      expectedWorkingHead: edited.workingHead,
      message: "Exercise template contribution",
    },
  ]);
  await agentCall("vcs.push", [
    {
      commandId: `template-e2e-publish:${randomUUID()}`,
      contextId,
      expectedCommittedEventId: committed.event.eventId,
      expectedMainEventId: before.mainEventId,
    },
  ]);
  return contextId;
}

async function readCurrentManagedText(repoPath: string, filePath: string): Promise<string | null> {
  const contextId = `template-git-e2e-observe-${randomUUID()}`;
  await agentCall("runtime.createContext", [{ contextId }]);
  return readManagedText(contextId, repoPath, filePath);
}

async function readManagedText(
  contextId: string,
  repoPath: string,
  filePath: string
): Promise<string | null> {
  const current = await status(contextId);
  const repository = await agentCall<{ repositoryId: string } | null>("vcs.resolveRepository", [
    { state: current.workingHead, repoPath },
  ]);
  if (!repository) throw new Error(`Missing semantic repository ${repoPath}`);
  const file = await agentCall<{
    content: { kind: "text"; text: string } | { kind: "bytes"; base64: string };
  } | null>("vcs.readFile", [
    {
      state: current.workingHead,
      repositoryId: repository.repositoryId,
      file: { kind: "path", path: filePath },
    },
  ]);
  if (!file) return null;
  if (file.content.kind !== "text") throw new Error(`Expected text at ${repoPath}/${filePath}`);
  return file.content.text;
}

async function createManagedText(
  contextId: string,
  repoPath: string,
  filePath: string,
  text: string
): Promise<void> {
  const before = await status(contextId);
  const repository = await agentCall<{ repositoryId: string } | null>("vcs.resolveRepository", [
    { state: before.workingHead, repoPath },
  ]);
  if (!repository) throw new Error(`Missing semantic repository ${repoPath}`);
  const edited = await agentCall<{ workingHead: unknown }>("vcs.edit", [
    {
      commandId: `template-e2e-repair:${randomUUID()}`,
      contextId,
      expectedWorkingHead: before.workingHead,
      intentSummary: "Satisfy the incoming template migration contract",
      changes: [
        {
          kind: "file-create",
          repositoryId: repository.repositoryId,
          path: filePath,
          content: { kind: "text", text },
          mode: 0o644,
        },
      ],
    },
  ]);
  await agentCall("vcs.commit", [
    {
      commandId: `template-e2e-commit-repair:${randomUUID()}`,
      contextId,
      expectedWorkingHead: edited.workingHead,
      intentSummary: "Record the verified migration repair",
      message: "Satisfy the v2 runtime migration contract",
    },
  ]);
}

async function writeTemplateFixture(worktree: string, revision: "v1" | "v2"): Promise<void> {
  await fs.mkdir(path.join(worktree, "meta"), { recursive: true });
  await fs.mkdir(path.join(worktree, "packages", templateAlias), { recursive: true });
  await fs.writeFile(path.join(worktree, "meta", "template.yml"), "systemEpoch: 58\n");
  await fs.writeFile(
    path.join(worktree, "packages", templateAlias, "package.json"),
    JSON.stringify({ name: `@fixture/${templateAlias}`, private: true, type: "module" }, null, 2) +
      "\n"
  );
  await fs.writeFile(
    path.join(worktree, "packages", templateAlias, "index.ts"),
    `export const templateRevision = ${JSON.stringify(revision)};\n`
  );
  if (revision === "v2") {
    const migrationDirectory = path.join(worktree, "migrations", templateAlias);
    await fs.mkdir(migrationDirectory, { recursive: true });
    await fs.writeFile(
      path.join(migrationDirectory, "runtime-contract.md"),
      [
        "---",
        "degraded-ok: false",
        "verify: |",
        `  Confirm packages/${templateAlias}/migration-ready.ts exists and the localCustomization export remains in index.ts.`,
        "---",
        "",
        "# Preserve the customized runtime while adopting v2",
        "",
        "The v2 runtime requires migration-ready.ts. Preserve any workspace-owned",
        "localCustomization export while bringing the template revision to v2.",
        "",
      ].join("\n")
    );
  }
}

async function canonicalGitSnapshot(worktree: string, commit: string): Promise<string> {
  const listing = (
    await execFileAsync(
      "git",
      ["ls-tree", "-r", "-z", "--format=%(objectmode)%x09%(objecttype)%x09%(path)", commit],
      { cwd: worktree, encoding: "buffer", maxBuffer: 10 * 1024 * 1024 }
    )
  ).stdout;
  const entries: Array<{
    path: string;
    mode: number;
    size: number;
    contentHash: string;
  }> = [];
  for (const raw of listing.toString("utf8").split("\0")) {
    if (!raw) continue;
    const [modeText, type, filePath] = raw.split("\t");
    if (type !== "blob" || !modeText || !filePath) continue;
    const bytes = (
      await execFileAsync("git", ["show", `${commit}:${filePath}`], {
        cwd: worktree,
        encoding: "buffer",
        maxBuffer: 10 * 1024 * 1024,
      })
    ).stdout;
    entries.push({
      path: filePath,
      mode: modeText === "100755" ? 0o100755 : 0o100644,
      size: bytes.byteLength,
      contentHash: sha256Hex(bytes),
    });
  }
  return canonicalSnapshotDigest(entries);
}

async function promoteTemplate(
  registryWorktree: string,
  registryRemoteUrl: string,
  templateUrl: string,
  commit: string,
  snapshot: string,
  revision: string
): Promise<void> {
  await fs.writeFile(
    path.join(registryWorktree, "registry.yml"),
    YAML.stringify({
      version: 1,
      revision,
      systemEpoch: 58,
      entries: [
        {
          id: templateAlias,
          name: "Full-stack template",
          description: "Deterministic smart-HTTP template fixture.",
          tags: ["test"],
          recommended: false,
          url: templateUrl,
          promoted: {
            ref: "refs/heads/main",
            commit,
            snapshot,
          },
        },
      ],
    })
  );
  await nativeGit(registryWorktree, ["add", "registry.yml"]);
  await nativeGit(registryWorktree, ["commit", "-m", `promote ${revision}`]);
  if (!(await execFileAsync("git", ["remote"], { cwd: registryWorktree })).stdout.trim()) {
    await nativeGit(registryWorktree, ["remote", "add", "origin", registryRemoteUrl]);
  }
  await nativeGit(registryWorktree, ["push", "origin", "main"]);
}

async function copyWorkspaceTemplate(source: string, destination: string): Promise<void> {
  await fs.cp(source, destination, {
    recursive: true,
    filter: (entry) => {
      const name = path.basename(entry);
      return name !== "node_modules" && name !== ".git" && name !== ".cache";
    },
  });
}

async function linkAppRootEntry(appRoot: string, name: string): Promise<void> {
  const source = path.join(root, name);
  const target = path.join(appRoot, name);
  await fs.symlink(source, target, (await fs.stat(source)).isDirectory() ? "dir" : "file");
}

async function prepareAppRoot(temp: string, registryUrl: string): Promise<string> {
  const appRoot = path.join(temp, "app-root");
  await fs.mkdir(appRoot);
  await copyWorkspaceTemplate(path.join(root, "workspace"), path.join(appRoot, "workspace"));
  for (const name of [
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "tsconfig.json",
    "node_modules",
    "packages",
    "dist",
    "build-resources",
    "src",
  ]) {
    await linkAppRootEntry(appRoot, name);
  }

  const compositionSourcePath = path.join(
    appRoot,
    "workspace",
    "meta",
    "templates",
    "workspace.yml"
  );
  const compositionSource = YAML.parseDocument(await fs.readFile(compositionSourcePath, "utf8"));
  compositionSource.setIn(["templates", "registry"], {
    url: registryUrl,
    ref: "refs/heads/main",
  });
  await fs.writeFile(compositionSourcePath, String(compositionSource));
  return appRoot;
}

afterEach(async () => {
  await stopServer();
});

describe("full-stack template Git UX", () => {
  it.runIf(RUN)(
    "rehearses an overlapping migration through restart, repair, and resume",
    async () => {
      const temp = await fs.mkdtemp(path.join(os.tmpdir(), "vibestudio-template-git-e2e-"));
      const fixtureGit = new SmartGitHttpFixture(path.join(temp, "remotes"));
      try {
        await fs.mkdir(path.join(temp, "remotes"), { recursive: true });
        await fixtureGit.start();
        const templateRemote = await fixtureGit.create(templateAlias, "main");
        const installedTemplateAlias = templateAliasFromUrl(templateRemote.url);
        const worktree = path.join(temp, "template");
        await fs.mkdir(worktree);
        await nativeGit(worktree, ["init", "--initial-branch=main"]);
        await nativeGit(worktree, ["config", "user.name", "Template E2E"]);
        await nativeGit(worktree, ["config", "user.email", "template-e2e@vibestudio.local"]);
        await writeTemplateFixture(worktree, "v1");
        await nativeGit(worktree, ["add", "."]);
        await nativeGit(worktree, ["commit", "-m", "template v1"]);
        await nativeGit(worktree, ["remote", "add", "origin", templateRemote.url]);
        await nativeGit(worktree, ["push", "origin", "main"]);
        const templateV1Commit = (
          await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: worktree })
        ).stdout.trim();
        const templateV1Snapshot = await canonicalGitSnapshot(worktree, templateV1Commit);
        await nativeGit(worktree, ["tag", "v1.0.0", templateV1Commit]);
        await nativeGit(worktree, ["push", "origin", "refs/tags/v1.0.0"]);

        const registryRemote = await fixtureGit.create("template-registry", "main");
        const registryWorktree = path.join(temp, "template-registry");
        await fs.mkdir(registryWorktree);
        await nativeGit(registryWorktree, ["init", "--initial-branch=main"]);
        await nativeGit(registryWorktree, ["config", "user.name", "Registry E2E"]);
        await nativeGit(registryWorktree, [
          "config",
          "user.email",
          "registry-e2e@vibestudio.local",
        ]);
        await promoteTemplate(
          registryWorktree,
          registryRemote.url,
          templateRemote.url,
          templateV1Commit,
          templateV1Snapshot,
          "2026-07-29.1"
        );

        const appRoot = await prepareAppRoot(temp, registryRemote.url);
        serverOutput = "";
        server = spawn(
          "pnpm",
          ["server:live", "--ephemeral", "--instance", instance, "--app-root", appRoot],
          {
            cwd: root,
            detached: process.platform !== "win32",
            stdio: ["ignore", "pipe", "pipe"],
          }
        );
        server.stdout?.on("data", captureServerOutput);
        server.stderr?.on("data", captureServerOutput);
        await waitForCli();
        await agentCall("runtime.createContext", [{ contextId: inspectionContextId }]);

        // Root initialization is the only pre-userland Git path. Ordinary Git
        // remains unavailable until its userland extension is approved.
        expect(
          await cliError(["vcs", "git", "status", "--repo", templateRepoPath, "--json"])
        ).toMatch(/unavailable|not registered|approval|extension/iu);

        // This is intentionally the only blanket approval.  Its implementation
        // rejects anything except exact startup unit-batch cards.
        await cli<unknown>(["system-test", "doctor", "--approve-startup", "--json"], 180_000);

        await runWithAnyApprovals(() =>
          agentCall("credentials.storeCredential", [
            {
              label: gitCredentialLabel,
              audience: [{ url: templateRemote.url, match: "origin" }],
              injection: {
                type: "basic-auth",
                usernameTemplate: gitUsername,
                passwordTemplate: "{token}",
              },
              bindings: [
                {
                  id: "fixture-git-http",
                  label: "Fixture smart HTTP",
                  use: "git-http",
                  audience: [{ url: templateRemote.url, match: "origin" }],
                  injection: {
                    type: "basic-auth",
                    usernameTemplate: gitUsername,
                    passwordTemplate: "{token}",
                  },
                },
              ],
              material: { type: "api-key", token: gitPassword },
            },
          ])
        );

        await runWithAnyApprovals(
          () => cli<unknown>(["templates", "catalog", "--refresh", "--json"], 180_000),
          180_000
        );

        const publicationReceiptPath = path.join(temp, "template-publication.json");
        await fs.writeFile(
          publicationReceiptPath,
          `${JSON.stringify(
            {
              operationId: "fixture-publication-v1",
              destination: {
                provider: "fixture",
                owner: "fixture",
                name: templateAlias,
              },
              created: false,
              remoteUrl: templateRemote.url,
              webUrl: templateRemote.url,
              templateUrl: normalizeTemplateGitUrl(templateRemote.url),
              ref: "refs/tags/v1.0.0",
              commit: templateV1Commit,
              snapshot: templateV1Snapshot,
              parts: [templateRepoPath],
            },
            null,
            2
          )}\n`
        );
        const registrySuggestion = await runWithAnyApprovals(
          () =>
            cli<{
              branch: string;
              entry: { promoted: { ref: string; commit: string } };
            }>(
              [
                "templates",
                "registry-suggest",
                publicationReceiptPath,
                "--id",
                templateAlias,
                "--name",
                "Full-stack template",
                "--description",
                "Deterministic smart-HTTP template fixture.",
                "--tag",
                "test",
                "--revision",
                "2026-07-29.2",
                "--command-id",
                "registry-suggestion-v1",
                "--json",
              ],
              300_000
            ),
          300_000
        );
        expect(registrySuggestion.value.entry.promoted).toEqual({
          ref: "refs/tags/v1.0.0",
          commit: templateV1Commit,
          snapshot: templateV1Snapshot,
        });
        await nativeGit(registryWorktree, ["fetch", "origin", registrySuggestion.value.branch]);
        const suggestedRegistry = YAML.parse(
          (
            await execFileAsync("git", ["show", `FETCH_HEAD:registry.yml`], {
              cwd: registryWorktree,
            })
          ).stdout
        ) as { revision: string; entries: Array<{ id: string; promoted: { ref: string } }> };
        expect(suggestedRegistry.revision).toBe("2026-07-29.2");
        expect(suggestedRegistry.entries).toContainEqual(
          expect.objectContaining({
            id: templateAlias,
            promoted: expect.objectContaining({ ref: "refs/tags/v1.0.0" }),
          })
        );

        const inspected = await cli<{ templates: Array<{ commit: string }> }>([
          "templates",
          "inspect",
          templateRemote.url,
          "--json",
        ]);
        expect(inspected.value.templates).toContainEqual(
          expect.objectContaining({ commit: templateV1Commit })
        );
        const addId = `template-add:${randomUUID()}`;
        const added = await runWithTemplateApprovals<{ state: string; blocker?: unknown }>([
          "templates",
          "add",
          "--catalog",
          templateAlias,
          "--command-id",
          addId,
          "--json",
        ]);
        expect(added.value.state, JSON.stringify(added.value, null, 2)).toBe("applied");
        const installed = {
          value: await waitForTemplateState(installedTemplateAlias, "current"),
        };
        expect(installed.value).toContainEqual(
          expect.objectContaining({ alias: installedTemplateAlias, state: "current" })
        );

        // Keep a real workspace-owned edit in the same repository the next
        // release changes. The migration rehearsal must preserve it rather
        // than replacing the local layer with the template's v2 snapshot.
        await replaceProtectedText(
          templateRepoPath,
          "index.ts",
          [
            'export const templateRevision = "v1";',
            "export const localCustomization = true;",
            "",
          ].join("\n")
        );
        expect(await readCurrentManagedText(templateRepoPath, "index.ts")).toContain(
          "localCustomization"
        );

        await writeTemplateFixture(worktree, "v2");
        await nativeGit(worktree, ["add", "."]);
        await nativeGit(worktree, ["commit", "-m", "template v2"]);
        const templateV2Commit = (
          await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: worktree })
        ).stdout.trim();
        await nativeGit(worktree, ["push", "origin", "main"]);
        const templateV2Snapshot = await canonicalGitSnapshot(worktree, templateV2Commit);
        await promoteTemplate(
          registryWorktree,
          registryRemote.url,
          templateRemote.url,
          templateV2Commit,
          templateV2Snapshot,
          "2026-07-29.3"
        );
        await cli<unknown>(["templates", "catalog", "--refresh", "--json"], 180_000);
        const pullId = `template-pull:${randomUUID()}`;
        const pulled = await runWithTemplateApprovals<{
          operationId: string;
          review?: { contextId: string; items: Array<{ sourceDeltaId: string }> };
        }>(["templates", "pull", installedTemplateAlias, "--command-id", pullId, "--json"]);

        // A changed owned part produces external deltas.  Review their exact
        // changes through public VCS calls before template finalization.
        expect(pulled.value.review?.items.length).toBeGreaterThan(0);
        const contextId = pulled.value.review!.contextId;
        let reviewedChanges = 0;
        for (const { sourceDeltaId } of pulled.value.review!.items) {
          const current = await status(contextId);
          const comparison = await cli<{
            coordinates: Array<{
              coordinate: { kind: "file" | "repository"; id: string };
              status: string;
            }>;
            resolution: { concluded: boolean };
          }>([
            "agent",
            "call",
            "vcs.compare",
            JSON.stringify([
              {
                source: { kind: "external-delta", deltaId: sourceDeltaId },
                target: current.workingHead,
                limit: 200,
              },
            ]),
            "--json",
          ]);
          const mergeable = comparison.value.coordinates
            .filter((coordinate) => coordinate.status !== "conflict")
            .map(({ coordinate }) => ({ kind: coordinate.kind, id: coordinate.id }));
          reviewedChanges += mergeable.length;
          if (mergeable.length === 0 && comparison.value.resolution.concluded) continue;
          await cli<unknown>([
            "agent",
            "call",
            "vcs.merge",
            JSON.stringify([
              {
                commandId: `template-adopt:${randomUUID()}`,
                contextId,
                expectedWorkingHead: current.workingHead,
                source: { kind: "external-delta", deltaId: sourceDeltaId },
                coordinates: mergeable,
              },
            ]),
            "--json",
          ]);
        }
        expect(reviewedChanges).toBeGreaterThan(0);
        const held = await runWithTemplateApprovals<{
          operationId: string;
          initiator: "user" | "host-release";
          state: string;
          migration?: {
            facets: string[];
            notes: Array<{ path: string; title: string; degradedOk: boolean }>;
          };
          repair?: { contextId: string };
        }>(
          ["templates", "pull", installedTemplateAlias, "--command-id", pullId, "--json"],
          180_000
        );
        expect(held.value).toMatchObject({
          operationId: pullId,
          initiator: "user",
          state: "repairing",
          migration: {
            facets: [templateAlias],
            notes: [
              {
                path: `migrations/${templateAlias}/runtime-contract.md`,
                title: "Preserve the customized runtime while adopting v2",
                degradedOk: false,
              },
            ],
          },
          repair: { contextId },
        });

        // The note's probe fails in the retained context before repair, while
        // the overlapping local customization is already preserved.
        expect(await readManagedText(contextId, templateRepoPath, "migration-ready.ts")).toBeNull();
        expect(await readManagedText(contextId, templateRepoPath, "index.ts")).toContain(
          "localCustomization"
        );

        // Restart the exact Composer execution. Its process-local state is
        // discarded; operations() must reconstruct this repair from the
        // durable semantic context.
        const supervised = await agentCall<
          Array<{
            identity: { kind: "extension"; entityId: string };
            source: string;
          }>
        >("runtime.supervision.list", []);
        const composer = supervised.find(
          (unit) =>
            unit.identity.kind === "extension" && unit.source === "extensions/template-composer"
        );
        expect(composer).toBeDefined();
        await runWithAnyApprovals(() =>
          agentCall("runtime.supervision.restart", [composer!.identity])
        );
        const resumedOperations = await cli<
          Array<{
            operationId: string;
            contextId: string;
            state: string;
            migration?: { notes: Array<{ title: string }> };
          }>
        >(["templates", "operations", "--json"]);
        expect(resumedOperations.value).toContainEqual(
          expect.objectContaining({
            operationId: pullId,
            contextId,
            state: "repairing",
            migration: expect.objectContaining({
              notes: [
                expect.objectContaining({
                  title: "Preserve the customized runtime while adopting v2",
                }),
              ],
            }),
          })
        );

        await createManagedText(
          contextId,
          templateRepoPath,
          "migration-ready.ts",
          'export const migrationReady = "v2";\n'
        );
        expect(await readManagedText(contextId, templateRepoPath, "migration-ready.ts")).toContain(
          'migrationReady = "v2"'
        );
        expect(await readManagedText(contextId, templateRepoPath, "index.ts")).toContain(
          "localCustomization"
        );

        const resumed = await runWithTemplateApprovals<{ state: string }>(
          ["templates", "resume", pullId, "--json"],
          180_000
        );
        expect(resumed.value.state).toBe("applied");
        expect(await readCurrentManagedText(templateRepoPath, "index.ts")).toContain(
          "localCustomization"
        );
        expect(await readCurrentManagedText(templateRepoPath, "migration-ready.ts")).toContain(
          'migrationReady = "v2"'
        );
        expect(
          (await cli<Array<{ alias: string; commit: string }>>(["templates", "status", "--json"]))
            .value
        ).toContainEqual(
          expect.objectContaining({ alias: installedTemplateAlias, commit: templateV2Commit })
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${message}${serverDiagnostics()}`, { cause: error });
      } finally {
        await fixtureGit.stop().catch(() => undefined);
        await fs.rm(temp, { recursive: true, force: true });
      }
    },
    900_000
  );
});

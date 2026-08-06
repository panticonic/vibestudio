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

async function cli<T>(args: string[], timeout = 90_000): Promise<CommandResult<T>> {
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
  timeout = 90_000
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

async function cliError(args: string[], timeout = 90_000): Promise<string> {
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
  const pending = await cli<Array<{ approvalId: string; kind?: string }>>([
    "agent",
    "call",
    "shellApproval.listPending",
    "[]",
    "--json",
  ]);
  const card = pending.value.find((entry) => entry.approvalId === cardRef);
  expect(card).toBeDefined();
  await cli<void>([
    "agent",
    "call",
    card?.kind === "userland" ? "shellApproval.resolveUserland" : "shellApproval.resolve",
    JSON.stringify([cardRef, "once"]),
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

async function runWithAnyApprovals<T>(
  operation: () => Promise<T>,
  timeout = 90_000
): Promise<T> {
  const before = await cli<Array<{ approvalId: string }>>([
    "agent",
    "call",
    "shellApproval.listPending",
    "[]",
    "--json",
  ]);
  const existing = new Set(before.value.map(({ approvalId }) => approvalId));
  const pending = operation();
  let outcome:
    | { state: "resolved"; value: T }
    | { state: "rejected"; error: unknown }
    | undefined;
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
): Promise<void> {
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
}

async function waitForContribution(alias: string): Promise<{ branch: string; url?: string }> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const rows = (
      await cli<
        Array<{
          alias: string;
          contribution?: { branch: string; url?: string };
          blocker?: { message: string };
          error?: string;
        }>
      >(["templates", "status", "--json"])
    ).value;
    const row = rows.find((candidate) => candidate.alias === alias);
    if (row?.blocker || row?.error) {
      throw new Error(
        `Template ${alias} contribution failed: ${row.blocker?.message ?? row.error}`
      );
    }
    const contribution = row?.contribution;
    if (contribution) return contribution;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Template ${alias} did not publish a contribution branch`);
}

async function writeTemplateFixture(worktree: string, revision: "v1" | "v2"): Promise<void> {
  await fs.mkdir(path.join(worktree, "meta"), { recursive: true });
  await fs.mkdir(path.join(worktree, "packages", templateAlias), { recursive: true });
  await fs.writeFile(path.join(worktree, "meta", "template.yml"), "systemEpoch: 57\n");
  await fs.writeFile(
    path.join(worktree, "packages", templateAlias, "package.json"),
    JSON.stringify({ name: `@fixture/${templateAlias}`, private: true, type: "module" }, null, 2) +
      "\n"
  );
  await fs.writeFile(
    path.join(worktree, "packages", templateAlias, "index.ts"),
    `export const templateRevision = ${JSON.stringify(revision)};\n`
  );
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
      systemEpoch: 57,
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
    "seed",
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
    "uses smart HTTP, approvals, semantic review, and audit end to end",
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
        const rootTemplateRemote = await fixtureGit.create("workspace-base", "main");
        const rootTemplateWorktree = path.join(appRoot, "workspace");
        await nativeGit(rootTemplateWorktree, ["init", "--initial-branch=main"]);
        await nativeGit(rootTemplateWorktree, ["config", "user.name", "Workspace Base E2E"]);
        await nativeGit(rootTemplateWorktree, [
          "config",
          "user.email",
          "workspace-base-e2e@vibestudio.local",
        ]);
        await nativeGit(rootTemplateWorktree, ["add", "."]);
        await nativeGit(rootTemplateWorktree, ["commit", "-m", "workspace base fixture"]);
        await nativeGit(rootTemplateWorktree, ["remote", "add", "origin", rootTemplateRemote.url]);
        await nativeGit(rootTemplateWorktree, ["push", "origin", "main"]);
        const rootTemplateCommit = (
          await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: rootTemplateWorktree })
        ).stdout.trim();
        const rootTemplateSnapshot = await canonicalGitSnapshot(
          rootTemplateWorktree,
          rootTemplateCommit
        );
        fixtureGit.protect("workspace-base", gitUsername, gitPassword);
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

        const inspected = await cli<{ templates: Array<{ commit: string }> }>([
          "templates",
          "inspect",
          templateRemote.url,
          "--json",
        ]);
        expect(inspected.value.templates).toHaveLength(1);
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

        // Author an ordinary protected-main change, suggest it through the
        // template API, and let a simulated maintainer fast-forward main to
        // the exact contribution branch. Pull must then recognize that exact
        // round trip without inventing a second review channel.
        await replaceProtectedText(
          templateRepoPath,
          "index.ts",
          'export const templateRevision = "suggested-by-workspace";'
        );
        expect(await waitForTemplateState(installedTemplateAlias, "local-changes")).toContainEqual(
          expect.objectContaining({ alias: installedTemplateAlias, state: "local-changes" })
        );
        const suggested = await runWithTemplateApprovals<{
          contribution?: { branch: string; url?: string };
        }>([
          "templates",
          "suggest",
          installedTemplateAlias,
          "--part",
          templateRepoPath,
          "--command-id",
          `template-suggest:${randomUUID()}`,
          "--json",
        ]);
        const contribution =
          suggested.value.contribution ?? (await waitForContribution(installedTemplateAlias));
        expect(contribution.branch).toMatch(/^vibestudio\//u);
        expect(contribution.url).toBeUndefined();
        await nativeGit(worktree, ["fetch", "origin", contribution.branch]);
        const contributionCommit = (
          await execFileAsync("git", ["rev-parse", `origin/${contribution.branch}`], {
            cwd: worktree,
          })
        ).stdout.trim();
        await nativeGit(worktree, ["merge", "--ff-only", `origin/${contribution.branch}`]);
        await nativeGit(worktree, ["push", "origin", "main"]);
        const contributionSnapshot = await canonicalGitSnapshot(worktree, contributionCommit);
        await promoteTemplate(
          registryWorktree,
          registryRemote.url,
          templateRemote.url,
          contributionCommit,
          contributionSnapshot,
          "2026-07-29.2"
        );
        await cli<unknown>(["templates", "catalog", "--refresh", "--json"], 180_000);
        await runWithTemplateApprovals([
          "templates",
          "pull",
          installedTemplateAlias,
          "--command-id",
          `template-recognize:${randomUUID()}`,
          "--json",
        ]);
        await waitForTemplateState(installedTemplateAlias, "current");
        expect(
          (await cli<Array<{ alias: string; commit: string }>>(["templates", "status", "--json"]))
            .value
        ).toContainEqual(
          expect.objectContaining({ alias: installedTemplateAlias, commit: contributionCommit })
        );

        // A second real smart-HTTP remote proves the ordinary workspace Git
        // bridge path; it is not the template fixture's native Git push above.
        const workspaceRemote = await fixtureGit.create("workspace-push", "main");
        fixtureGit.protect("workspace-push", gitUsername, gitPassword);
        await cli<unknown>([
          "vcs",
          "git",
          "remote",
          "set",
          "--repo",
          templateRepoPath,
          "--url",
          workspaceRemote.url,
          "--branch",
          workspaceRemote.branch,
          "--json",
        ]);
        await cli<unknown>([
          "vcs",
          "git",
          "enable",
          "--repo",
          templateRepoPath,
          "--credential",
          gitCredentialLabel,
          "--json",
        ]);
        await runWithAnyApprovals(
          () =>
            cli<unknown>(
              ["vcs", "git", "push", "--repo", templateRepoPath, "--json"],
              180_000
            ),
          180_000
        );
        expect(await fixtureGit.inspect("workspace-push")).toMatchObject({
          branch: "main",
          commitCount: expect.any(Number),
          headCommit: expect.any(String),
        });

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
          review?: { contextId: string; items: Array<{ deltaId: string }> };
        }>(["templates", "pull", installedTemplateAlias, "--command-id", pullId, "--json"]);

        // A changed owned part produces external deltas.  Review their exact
        // changes through public VCS calls before template finalization.
        expect(pulled.value.review?.items.length).toBeGreaterThan(0);
        const contextId = pulled.value.review!.contextId;
        let reviewedChanges = 0;
        for (const { deltaId } of pulled.value.review!.items) {
          const current = await status(contextId);
          const comparison = await cli<{
            changes: Array<{ changeId: string; disposition: { status: string } }>;
          }>([
            "agent",
            "call",
            "vcs.compare",
            JSON.stringify([
              {
                source: { kind: "external-delta", deltaId },
                target: current.workingHead,
                limit: 200,
              },
            ]),
            "--json",
          ]);
          const mergeable = comparison.value.coordinates
            .filter((coordinate) => coordinate.status !== "conflict")
            .map((coordinate) => coordinate.coordinate);
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
                source: { kind: "external-delta", deltaId },
                coordinates: mergeable,
              },
            ]),
            "--json",
          ]);
        }
        expect(reviewedChanges).toBeGreaterThan(0);
        await runWithTemplateApprovals(
          ["templates", "pull", installedTemplateAlias, "--command-id", pullId, "--json"],
          180_000
        );
        await waitForTemplateState(installedTemplateAlias, "current");
        expect(
          (await cli<Array<{ alias: string; commit: string }>>(["templates", "status", "--json"]))
            .value
        ).toContainEqual(
          expect.objectContaining({ alias: installedTemplateAlias, commit: templateV2Commit })
        );

        const removed = await runWithTemplateApprovals<{ orphanedParts: string[] }>([
          "templates",
          "remove",
          installedTemplateAlias,
          "--command-id",
          `template-remove:${randomUUID()}`,
          "--json",
        ]);
        expect(removed.value.orphanedParts).toContain(templateRepoPath);
        const afterRemoval = await waitForTemplateState(installedTemplateAlias, null);
        expect(afterRemoval).not.toContainEqual(
          expect.objectContaining({ alias: installedTemplateAlias })
        );

        const audit = await cli<Array<{ url?: string; callerId?: string; workerId?: string }>>([
          "agent",
          "call",
          "credentials.audit",
          "[{}]",
          "--json",
        ]);
        const templateHttpEvents = audit.value.filter((event) =>
          event.url?.startsWith(templateRemote.url)
        );
        expect(templateHttpEvents.length).toBeGreaterThanOrEqual(3);
        expect(
          templateHttpEvents.some(
            (event) =>
              event.callerId?.includes("template-composer") ||
              event.workerId?.includes("template-composer")
          )
        ).toBe(true);
        expect(
          templateHttpEvents.some((event) => event.workerId?.startsWith("host:templates"))
        ).toBe(false);
        const workspacePushEvents = audit.value.filter((event) =>
          event.url?.startsWith(workspaceRemote.url)
        );
        expect(workspacePushEvents.length).toBeGreaterThan(0);
        expect(workspacePushEvents.some((event) => event.callerId?.includes("git-bridge"))).toBe(
          true
        );

        // Finally exercise the complete pre-userland boundary through the
        // public hub workflow. The caller supplies the already-inspected exact
        // pin; the host only verifies and imports that immutable root.
        const rootWorkspaceName = `root-e2e-${randomUUID().slice(0, 8)}`;
        await runWithAnyApprovals(
          () =>
            cli<unknown>(
              [
                "remote",
                "create-workspace",
                rootWorkspaceName,
                "--template",
                rootTemplateRemote.url,
                "--template-ref",
                "refs/heads/main",
                "--template-commit",
                rootTemplateCommit,
                "--template-snapshot",
                rootTemplateSnapshot,
                "--template-credential",
                gitCredentialLabel,
                "--json",
              ],
              180_000
            ),
          180_000
        );
        await cli<unknown>(["remote", "select", rootWorkspaceName, "--json"]);
        await waitForCli();
        await cli<unknown>(["system-test", "doctor", "--approve-startup", "--json"], 240_000);
        // Status is deliberately a pure offline read. An explicit userland
        // catalog operation performs the byte-identical root adoption first.
        await runWithAnyApprovals(
          () => cli<unknown>(["templates", "catalog", "--refresh", "--json"], 180_000),
          180_000
        );
        const adoptedRoot = await cli<Array<{ url: string; state: string }>>(
          ["templates", "status", "--json"],
          180_000
        );
        expect(adoptedRoot.value).toContainEqual(
          expect.objectContaining({
            url: normalizeTemplateGitUrl(rootTemplateRemote.url),
            state: "current",
          })
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${message}${serverDiagnostics()}`, { cause: error });
      } finally {
        await fixtureGit.stop().catch(() => undefined);
        await fs.rm(temp, { recursive: true, force: true });
      }
    },
    600_000
  );
});

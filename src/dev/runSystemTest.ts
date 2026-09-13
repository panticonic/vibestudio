#!/usr/bin/env node
import * as path from "node:path";
import * as fs from "node:fs";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import {
  adoptSystemTestSession,
  ensureSystemTestInstance,
  isLocalSystemTestHelpCommand,
  managedTestSessionName,
  parseSystemTestLauncherArgs,
  stopManagedSystemTestInstance,
} from "./systemTestInstance.js";
import {
  assertSystemTestPreparationResult,
  systemTestPreparationFailureDetail,
} from "./systemTestPreparation.js";
import {
  adoptSelfDevelopmentProjects,
  selfDevelopmentProjects,
  type SelfDevelopmentProject,
} from "./selfDevelopmentAdoption.js";
import {
  profileIsPaired,
  selectWorkspaceForRole,
  workspaceProfileRoot,
  type SystemTestWorkspaceProfile,
  type WorkspaceSummary,
} from "./systemTestWorkspaceProfile.js";

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");

const HELP = `Usage: pnpm system-test [--instance ID] [--bootstrap-workspace NAME] COMMAND [ARGS...]

Self-provisions one isolated Vibestudio server for headless agentic acceptance.

Commands:
  doctor                         Provision, pair, and check infrastructure
  list --json                    List tests from the live system-test runner
  run TEST_NAME                  Run one exact test
  inspect RUN_ID --json          Inspect a bounded failed-run packet
  trajectory RUN_ID TEST --full --json
                                 Inspect the full trajectory when needed
  rerun RUN_ID                   Rerun the still-relevant tests from a run
  stop                           Stop only this launcher's managed instance

Options:
  --instance ID                  Stable unique instance name (default: system-test)
  --bootstrap-workspace NAME     Use a named persistent bootstrap workspace
  --self-development             Adopt this checkout as projects/vibestudio
  --workspace-role dev|system    Run the command against this workspace of the
                                 instance (default: dev); system is where a
                                 desktop client registers its executor.
  -h, --help                     Show this help without starting infrastructure
`;

/**
 * Argv and environment for one CLI invocation, scoped or not.
 *
 * `--instance` resolves the instance and overwrites VIBESTUDIO_INSTANCE_ROOT,
 * which is exactly the root a scoped profile must not use — so a scoped
 * invocation names no instance and is located by its profile root alone.
 */
function cliInvocation(
  instanceId: string,
  command: readonly string[],
  profileRoot: string | undefined
): { argv: string[]; env: NodeJS.ProcessEnv } {
  if (!profileRoot) {
    return {
      argv: [tsxCli, "src/dev/runCli.ts", "--instance", instanceId, ...command],
      env: process.env,
    };
  }
  const env: NodeJS.ProcessEnv = { ...process.env, VIBESTUDIO_INSTANCE_ROOT: profileRoot };
  delete env["VIBESTUDIO_INSTANCE"];
  return { argv: [tsxCli, "src/dev/runCli.ts", ...command], env };
}

function runCli(
  instanceId: string,
  command: readonly string[],
  profileRoot?: string
): Promise<number> {
  return new Promise((resolve, reject) => {
    const invocation = cliInvocation(instanceId, ["system-test", ...command], profileRoot);
    const child = spawn(process.execPath, invocation.argv, {
      cwd: process.cwd(),
      env: invocation.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`system-test CLI exited from signal ${signal}`));
      else resolve(code ?? 1);
    });
  });
}

function prepareFreshInstance(instanceId: string, expectedWorkspaceId: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        tsxCli,
        "src/dev/runCli.ts",
        "--instance",
        instanceId,
        "system-test",
        "doctor",
        "--approve-startup",
        "--json",
      ],
      { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"] }
    );
    let output = "";
    let diagnostics = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      diagnostics += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`system-test startup preparation exited from signal ${signal}`));
      } else if (code !== 0) {
        reject(
          new Error(
            `system-test startup preparation failed:\n${systemTestPreparationFailureDetail(
              output,
              diagnostics
            )}`
          )
        );
      } else {
        try {
          assertSystemTestPreparationResult(output, expectedWorkspaceId);
          resolve();
        } catch (error) {
          reject(error);
        }
      }
    });
  });
}

/** Run one ordinary CLI command and capture what it reported. */
function captureCli(
  instanceId: string,
  command: readonly string[],
  profileRoot?: string
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const invocation = cliInvocation(instanceId, command, profileRoot);
    const child = spawn(process.execPath, invocation.argv, {
      cwd: process.cwd(),
      env: invocation.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`${command[0]} exited from signal ${signal}`));
      else resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function adoptSelfDevelopmentSource(
  instanceId: string,
  projects: readonly SelfDevelopmentProject[],
  profileRoot?: string
): Promise<void> {
  if (projects.length === 0) return;
  const adopted = await adoptSelfDevelopmentProjects({
    projects,
    runCli: (args) => captureCli(instanceId, args, profileRoot),
  });
  for (const project of adopted) {
    console.error(
      `[system-test] ${project.adopted ? "adopted" : "reusing"} ${project.repoPath} ` +
        `from ${project.url}`
    );
  }
}

/**
 * Bind a scoped CLI profile to the instance's workspace for `role`.
 *
 * The profile is paired the ordinary way — the instance's own profile mints a
 * device invite, and the scoped profile redeems it — so the second binding is
 * an ordinary device credential rather than a copied one.
 */
async function ensureWorkspaceProfile(
  instanceId: string,
  instanceRoot: string,
  role: "system"
): Promise<SystemTestWorkspaceProfile> {
  const listed = await captureCli(instanceId, ["remote", "workspaces", "--json"]);
  if (listed.code !== 0) {
    throw new Error(
      `Could not list workspaces on ${instanceId}: ${listed.stderr || listed.stdout}`
    );
  }
  const workspaces = (
    JSON.parse(listed.stdout.trim().split("\n").at(-1) ?? "{}") as {
      workspaces?: WorkspaceSummary[];
    }
  ).workspaces;
  const workspace = selectWorkspaceForRole(workspaces ?? [], role);
  const root = workspaceProfileRoot(instanceRoot, role);
  const profile: SystemTestWorkspaceProfile = {
    root,
    workspaceId: workspace.workspaceId,
    workspaceName: workspace.name,
  };
  if (profileIsPaired(root, workspace.workspaceId)) return profile;

  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const invited = await captureCli(instanceId, [
    "remote",
    "pair-device",
    "--workspace",
    workspace.name,
    "--json",
  ]);
  if (invited.code !== 0) {
    throw new Error(
      `Could not invite a ${role}-workspace profile: ${invited.stderr || invited.stdout}`
    );
  }
  const link = (
    JSON.parse(invited.stdout.trim().split("\n").at(-1) ?? "{}") as {
      pairing?: { deepLink?: string };
    }
  ).pairing?.deepLink;
  if (!link) throw new Error(`The ${role}-workspace invite carried no pairing link`);
  const paired = await captureCli(
    instanceId,
    ["remote", "pair", link, "--label", `system-test-${role}`, "--json"],
    root
  );
  if (paired.code !== 0) {
    throw new Error(
      `Could not pair the ${role}-workspace profile: ${paired.stderr || paired.stdout}`
    );
  }
  console.error(
    `[system-test] scoped ${role}-workspace profile paired to ${workspace.name} (${workspace.workspaceId})`
  );
  return profile;
}

function pairedWorkspaceId(instanceRoot: string): string {
  const credentialsPath = path.join(instanceRoot, "cli-credentials.json");
  const value = JSON.parse(fs.readFileSync(credentialsPath, "utf8")) as Record<string, unknown>;
  if (typeof value["workspaceId"] !== "string" || value["workspaceId"].length === 0) {
    throw new Error(`managed instance credentials do not name a workspace: ${credentialsPath}`);
  }
  return value["workspaceId"];
}

async function main(): Promise<void> {
  const repoRoot = path.resolve(process.cwd());
  const parsed = parseSystemTestLauncherArgs(process.argv.slice(2));
  if (isLocalSystemTestHelpCommand(parsed.command)) {
    process.stdout.write(HELP);
    return;
  }
  if (parsed.command[0] === "stop") {
    if (parsed.command.length !== 1)
      throw new Error("usage: pnpm system-test [--instance ID] stop");
    const stopped = await stopManagedSystemTestInstance(repoRoot, parsed.instanceId);
    console.error(
      stopped
        ? `[system-test] stopped managed instance ${parsed.instanceId}`
        : `[system-test] managed instance ${parsed.instanceId} is not running`
    );
    return;
  }
  if (parsed.command.length === 0) {
    throw new Error("usage: pnpm system-test [--instance ID] COMMAND [ARGS...]");
  }
  const ensured = await ensureSystemTestInstance(repoRoot, parsed.instanceId, {
    explicitInstance: parsed.explicitInstance,
    ...(parsed.bootstrapWorkspace ? { bootstrapWorkspace: parsed.bootstrapWorkspace } : {}),
    ...(parsed.selfDevelopment ? { selfDevelopment: true } : {}),
  });
  process.env["VIBESTUDIO_INSTANCE_ROOT"] = ensured.instance.root;
  process.env["VIBESTUDIO_INSTANCE"] = ensured.instance.id;
  console.error(
    `[system-test] ${ensured.created ? "created" : "using"} instance ${ensured.instance.id}; ` +
      `workspace=${pairedWorkspaceId(ensured.instance.root)}`
  );
  // The ready record means the host is addressable, not that asynchronous
  // workspace installation/admission has settled. A server provisioned for
  // unattended system tests owns that startup review, so settle it before the
  // first test command can race the review publication. Unmanaged existing
  // instances are deliberately left alone: their reviews may belong to an
  // interactive user. Managed instances retain ownership across launcher
  // retries, including recovery from a failed first doctor call.
  // Provisioning is not complete at the ready-file boundary. Run the same
  // semantic startup barrier for every newly created instance, including a
  // caller whose first command is doctor. Relying on that outer doctor alone
  // leaves a race where it can return at transport readiness and the creation
  // review appears immediately afterward, blocking the first real test.
  if (ensured.created) {
    // Startup preparation has to come first: until the creation review is
    // resolved, the workspace refuses to invoke the extension that adopts a
    // project. It also creates the system-test session, whose context forks
    // main at that moment — so tests move to a session created afterwards.
    await prepareFreshInstance(ensured.instance.id, pairedWorkspaceId(ensured.instance.root));
  }
  // A scoped profile is a different workspace of the same server, with its own
  // semantic history: repositories adopted for one are absent from the other,
  // so each workspace a run targets adopts for itself. The scoped profile has
  // no session yet, so its first one forks main after that publication and the
  // instance profile's session move does not apply to it.
  const profile =
    parsed.workspaceRole === "system"
      ? await ensureWorkspaceProfile(ensured.instance.id, ensured.instance.root, "system")
      : null;
  if (profile) {
    console.error(
      `[system-test] scoped to the ${parsed.workspaceRole} workspace ${profile.workspaceName}`
    );
    // Every workspace owns its own creation review, and an unresolved one
    // refuses extension invocation — including the import that adopts a
    // project. The instance's own profile settles the dev workspace's review
    // during provisioning; this settles the scoped workspace's.
    const prepared = await captureCli(
      ensured.instance.id,
      ["system-test", "doctor", "--approve-startup", "--json"],
      profile.root
    );
    if (prepared.code !== 0) {
      throw new Error(
        `Could not settle startup for the ${parsed.workspaceRole} workspace: ` +
          `${prepared.stderr.trim() || prepared.stdout.trim()}`
      );
    }
  }
  if (parsed.selfDevelopment) {
    const projects =
      ensured.selfDevelopmentProjects.length > 0
        ? ensured.selfDevelopmentProjects
        : selfDevelopmentProjects(repoRoot);
    await adoptSelfDevelopmentSource(ensured.instance.id, projects, profile?.root);
    if (!profile) {
      const session = adoptSystemTestSession(ensured.instance, "self-development");
      console.error(`[system-test] tests on this instance run under session ${session}`);
    }
  }
  const command =
    ensured.managed &&
    parsed.command[0] === "doctor" &&
    !parsed.command.includes("--approve-startup")
      ? [...parsed.command, "--approve-startup"]
      : parsed.command;
  // Run the ordinary CLI in a fresh process after instance-scoped environment
  // has been installed. Several credential/path modules bind their stores at
  // module evaluation time; importing the CLI into this provisioning process
  // can therefore keep the pre-provision profile and also entangle its RPC
  // connection lifecycle with the launcher. The process boundary is the same
  // canonical path as `pnpm cli --instance ...` and preserves exit status.
  // A moved session belongs to the instance, not to one invocation, so every
  // later command on it has to name the same one. An explicit --session the
  // caller passed always wins.
  // A scoped profile carries its own session state, so the instance's moved
  // session name belongs only to the instance's own profile.
  // Both profiles need a session created after anything a run must see was
  // published to their workspace's main; a session's context forks main once,
  // when the session is created.
  const session = profile
    ? `system-tests-${parsed.workspaceRole}`
    : managedTestSessionName(ensured.instance);
  const scopedCommand =
    session && !command.includes("--session") ? [...command, "--session", session] : command;
  process.exitCode = await runCli(ensured.instance.id, scopedCommand, profile?.root);
}

try {
  await main();
} catch (error) {
  const record = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
  console.error(
    JSON.stringify({
      error: error instanceof Error ? error.message : String(error),
      classification: record["classification"] ?? "infrastructure",
      recoverable: record["recoverable"] ?? false,
      ...(record["automaticRecovery"] ? { automaticRecovery: record["automaticRecovery"] } : {}),
      ...(record["command"] ? { command: record["command"] } : {}),
    })
  );
  process.exitCode = 1;
}

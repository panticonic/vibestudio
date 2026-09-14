#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { createShellSurfaceLink } from "@vibestudio/shared/shellSurface";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { DevInstanceSupervisor } from "./devInstanceSupervisor.js";
import { DerivedCacheCoordinator, derivedCacheDatabasePath } from "@vibestudio/shared/derivedCache";
import {
  clearDevInstanceReady,
  createEphemeralInstanceRoot,
  generatedInstanceId,
  persistentInstanceRoot,
  publishDevInstanceReady,
  registerDevInstance,
  removeEphemeralInstanceRoot,
  unregisterDevInstance,
  type DevInstanceRecord,
} from "./instanceRegistry.js";
import { resolveDevelopmentTemplateSet } from "./developmentTemplateSet.js";
import { developmentInstanceEnvironment } from "./developmentInstanceEnvironment.js";
import { extractDevelopmentTemplateCheckoutArguments } from "./developmentTemplateOptions.js";
import { readCurrentHostBuildGeneration } from "../../scripts/host-build-generations.mjs";
import { inspectWorkspaceSources } from "../workspaceTemplateSource.js";

const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");

type Mode = DevInstanceRecord["kind"];

async function prunePersistentInstanceBuildCache(root: string, instanceId: string): Promise<void> {
  const buildCacheRoot = path.join(root, "build-cache");
  const coordinator = new DerivedCacheCoordinator(derivedCacheDatabasePath(buildCacheRoot));
  try {
    const result = await coordinator.prune(buildCacheRoot);
    if (result.removedEntries > 0) {
      console.log(
        `[instance:${instanceId}] pruned ${result.removedEntries} cached builds ` +
          `(${(result.removedBytes / 1024 ** 3).toFixed(2)} GiB)`
      );
    }
    const cas = pruneUnreferencedInstanceCas(path.join(root, "cas"));
    if (cas.removedFiles > 0) {
      console.log(
        `[instance:${instanceId}] pruned ${cas.removedFiles} unreferenced CAS blobs ` +
          `(${(cas.removedBytes / 1024 ** 3).toFixed(2)} GiB)`
      );
    }
  } catch (error) {
    console.warn(
      `[instance:${instanceId}] build-cache pruning failed: ${error instanceof Error ? error.message : String(error)}`
    );
  } finally {
    coordinator.close();
  }
}

function pruneUnreferencedInstanceCas(root: string): {
  removedFiles: number;
  removedBytes: number;
} {
  const shaRoot = path.join(root, "sha256");
  let removedFiles = 0;
  let removedBytes = 0;
  const pending = [shaRoot];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      const storedPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(storedPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = fs.statSync(storedPath);
      if (stat.nlink !== 1) continue;
      fs.unlinkSync(storedPath);
      removedFiles += 1;
      removedBytes += stat.blocks * 512 || stat.size;
    }
  }
  return { removedFiles, removedBytes };
}

function extractInstance(argv: string[]): {
  instanceId?: string;
  templateCheckouts?: string;
  productionTemplates: boolean;
  forwarded: string[];
} {
  const forwarded: string[] = [];
  let instanceId: string | undefined;
  let templateCheckouts: string | undefined;
  let productionTemplates = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--instance") {
      const value = argv[index + 1];
      if (!value) throw new Error("--instance requires an id");
      if (instanceId) throw new Error("--instance may only be specified once");
      instanceId = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--instance=")) {
      if (instanceId) throw new Error("--instance may only be specified once");
      instanceId = arg.slice("--instance=".length);
      if (!instanceId) throw new Error("--instance requires an id");
      continue;
    }
    if (arg === "--template-checkouts") {
      const value = argv[index + 1];
      if (!value) throw new Error("--template-checkouts requires a path");
      if (templateCheckouts) throw new Error("--template-checkouts may only be specified once");
      templateCheckouts = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--template-checkouts=")) {
      if (templateCheckouts) throw new Error("--template-checkouts may only be specified once");
      templateCheckouts = arg.slice("--template-checkouts=".length);
      if (!templateCheckouts) throw new Error("--template-checkouts requires a path");
      continue;
    }
    if (arg === "--production-templates") {
      if (productionTemplates) throw new Error("--production-templates may only be specified once");
      productionTemplates = true;
      continue;
    }
    forwarded.push(arg);
  }
  return {
    ...(instanceId ? { instanceId } : {}),
    ...(templateCheckouts ? { templateCheckouts } : {}),
    productionTemplates,
    forwarded,
  };
}

function hasFlag(argv: readonly string[], name: string): boolean {
  return argv.some((arg) => arg === name || arg.startsWith(`${name}=`));
}

function withoutFlag(argv: readonly string[], name: string): string[] {
  return argv.filter((arg) => arg !== name && !arg.startsWith(`${name}=`));
}

function optionValue(argv: readonly string[], name: string): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === name) return argv[index + 1];
    if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  return undefined;
}

function run(
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; allowFailure?: boolean }
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: options.env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${path.basename(command)} exited on ${signal}`));
        return;
      }
      const exitCode = code ?? 1;
      if (exitCode !== 0 && !options.allowFailure) {
        reject(new Error(`${path.basename(command)} exited with code ${exitCode}`));
        return;
      }
      resolve(exitCode);
    });
  });
}

async function runServer(
  forwarded: string[],
  env: NodeJS.ProcessEnv,
  instance: DevInstanceRecord
): Promise<number> {
  // credentialStore/environment paths are resolved at module evaluation time.
  // Load the bootstrap only after main() has installed this instance's process
  // environment, so an ephemeral server can never mistake the developer's
  // ordinary CLI credential for its own.
  const { bootstrapInstanceCli } = await import("./bootstrapInstanceCli.js");
  await run(process.execPath, ["scripts/native-host-dependencies.mjs", "--repair"], { env });
  await run(process.execPath, ["build.mjs", "--source-server-prereqs"], { env });
  env["VIBESTUDIO_HOST_ARTIFACT_ROOT"] = readCurrentHostBuildGeneration(process.cwd(), "source");
  const configuredReadyFile = optionValue(forwarded, "--ready-file");
  const readyFile =
    configuredReadyFile ?? path.join(instance.root, "server-auth", "hub-ready.json");
  fs.rmSync(readyFile, { force: true });
  const serverArgs = configuredReadyFile ? forwarded : [...forwarded, "--ready-file", readyFile];
  const supervisor = new DevInstanceSupervisor({
    sourceRoot: fs.realpathSync(process.cwd()),
    command: process.execPath,
    args: [tsxCli, "src/server/index.ts", ...serverArgs],
    env,
    stdio: "inherit",
    forwardParentSignals: true,
    readiness: {
      file: readyFile,
      async onReady(ready) {
        const bootstrap = await bootstrapInstanceCli(ready);
        publishDevInstanceReady(instance, bootstrap);
        if (bootstrap.status === "invite-required") {
          console.warn(
            `[instance:${instance.id}] CLI is not paired. Create a device invite, then run ` +
              `\`pnpm cli --instance ${instance.id} remote pair <invite>\`.`
          );
        } else {
          console.log(
            `[instance:${instance.id}] CLI ${bootstrap.status}; workspace=${bootstrap.workspaceName}`
          );
        }
      },
    },
  });
  await supervisor.start();
  return supervisor.wait();
}

async function runDesktop(forwarded: string[], env: NodeJS.ProcessEnv): Promise<number> {
  await run(process.execPath, ["scripts/native-host-dependencies.mjs", "--repair"], { env });
  // Desktop launches share the repository host artifacts with parallel
  // developer instances. The coordinator waits for an in-flight build and
  // reuses its verified output; invoking build.mjs directly would clean the
  // shared dist/ while another instance is starting its workspace runtime.
  await run(process.execPath, ["scripts/ensure-host-build.mjs"], { env });
  const supervisor = new DevInstanceSupervisor({
    sourceRoot: fs.realpathSync(process.cwd()),
    command: process.execPath,
    args: ["scripts/run-electron.mjs", ...forwarded],
    env,
    stdio: "inherit",
    forwardParentSignals: true,
  });
  await supervisor.start();
  return await supervisor.wait();
}

async function main(): Promise<void> {
  const rawMode = process.argv[2];
  if (rawMode !== "desktop" && rawMode !== "server") {
    throw new Error("usage: runInstance.ts desktop|server [options]");
  }
  const mode: Mode = rawMode;
  const repoRoot = fs.realpathSync(process.cwd());
  const templateOptions = extractDevelopmentTemplateCheckoutArguments(process.argv.slice(3));
  const parsed = extractInstance(templateOptions.forwarded);
  if (mode === "server" && hasFlag(parsed.forwarded, "--help")) {
    console.log(`Developer instance options:
  --instance <id>  Use a named persistent isolated instance (default: source)
  --ephemeral      Use an isolated temporary instance root; combine with
                   --instance to give parallel CLI commands a stable target
  --template-checkouts <path>
                   Root containing base/, personal/, and system/ Git checkouts
  --template-checkout <path>
                   Use an optional template's visible worktree (repeatable)
  --workspace-checkout <path>
                   Open this checkout as an additional workspace
  --production-templates Ignore configured checkouts and boot the pinned releases
`);
    const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "development" };
    await run(process.execPath, ["build.mjs", "--source-server-prereqs"], { env });
    env["VIBESTUDIO_HOST_ARTIFACT_ROOT"] = readCurrentHostBuildGeneration(process.cwd(), "source");
    process.exitCode = await run(
      process.execPath,
      [tsxCli, "src/server/index.ts", ...parsed.forwarded],
      { env }
    );
    return;
  }
  const disposable = hasFlag(parsed.forwarded, "--ephemeral");
  // `--ephemeral` selects a disposable instance root and nothing else. It is
  // consumed here so that no launcher further down can read a second meaning
  // into the same word.
  const forwarded = withoutFlag(parsed.forwarded, "--ephemeral");
  const id = parsed.instanceId ?? (disposable ? generatedInstanceId(mode) : "source");
  const root = disposable ? createEphemeralInstanceRoot(id) : persistentInstanceRoot(repoRoot, id);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const instance = registerDevInstance({
    id,
    root,
    repoRoot,
    supervisorPid: process.pid,
    kind: mode,
    lifecycle: disposable ? "ephemeral" : "persistent",
    startedAt: Date.now(),
  });
  const checkpointTarget = path.join(root, "default-template-checkpoints", instance.generationId);
  const templateCheckpointRoot = path.join(
    root,
    "development-template-checkpoints",
    instance.generationId
  );
  try {
    const defaultTemplates =
      (await resolveDevelopmentTemplateSet({
        repoRoot,
        checkpointRoot: checkpointTarget,
        ...(parsed.templateCheckouts ? { explicitRoot: parsed.templateCheckouts } : {}),
        productionTemplates: parsed.productionTemplates,
      })) ?? undefined;
    if (!parsed.productionTemplates && !defaultTemplates) {
      throw new Error(
        "No development template checkouts are configured. Run `pnpm dev:templates setup`, " +
          "or select the shipped release explicitly with `pnpm dev:production`."
      );
    }
    const developmentTemplates = await inspectWorkspaceSources({
      checkouts: [
        ...new Set(
          [
            ...templateOptions.checkouts,
            ...(templateOptions.workspaceCheckout ? [templateOptions.workspaceCheckout] : []),
          ].map((checkout) => fs.realpathSync(path.resolve(checkout)))
        ),
      ],
      checkpointRoot: templateCheckpointRoot,
    });
    const targetWorkspace = templateOptions.workspaceCheckout
      ? developmentTemplates.find(
          (template) =>
            template.sourceCheckout ===
            fs.realpathSync(path.resolve(templateOptions.workspaceCheckout!))
        )
      : undefined;
    if (templateOptions.workspaceCheckout && !targetWorkspace) {
      throw new Error("The requested workspace checkout has no prepared template snapshot");
    }
    const selectedTemplate = templateOptions.workspaceCheckout
      ? undefined
      : developmentTemplates[0];
    const launchArgs = targetWorkspace
      ? [
          ...forwarded,
          ...(mode === "desktop" ? ["--workspace-create-if-missing"] : []),
          mode === "server" ? "--bootstrap-workspace" : "--workspace",
          `${path
            .basename(targetWorkspace.sourceCheckout)
            .replace(/[^a-zA-Z0-9_-]/g, "-")
            .slice(
              0,
              30
            )}-${createHash("sha256").update(JSON.stringify(targetWorkspace.pin)).digest("hex").slice(0, 24)}`,
        ]
      : [
          ...forwarded,
          ...(mode === "desktop" && selectedTemplate
            ? [
                createShellSurfaceLink({
                  kind: "workspace-chooser",
                  template: selectedTemplate.pin,
                }),
              ]
            : []),
        ];
    const sourceCoupled = id === "source" && !disposable;
    const env = developmentInstanceEnvironment({
      parent: process.env,
      repoRoot,
      instanceRoot: root,
      instanceId: id,
      sourceCoupled,
      disposable,
      ...(defaultTemplates ? { defaultTemplates } : {}),
      ...(targetWorkspace ? { initialWorkspaceTemplate: targetWorkspace.pin } : {}),
      ...(developmentTemplates.length ? { templates: developmentTemplates } : {}),
    });
    process.env["VIBESTUDIO_INSTANCE_ROOT"] = root;
    process.env["VIBESTUDIO_INSTANCE"] = id;

    // Only the lock owner may mutate this instance's readiness marker. Once
    // registered, concurrent CLI readers reject an older generation.
    if (mode === "server") clearDevInstanceReady(instance);
    console.log(`[instance:${id}] ${instance.lifecycle} ${mode} state: ${root}`);
    console.log(`[instance:${id}] CLI: pnpm cli --instance ${id} <command>`);
    if (parsed.productionTemplates) {
      console.log(`[instance:${id}] Templates: canonical pinned production releases`);
    }
    if (defaultTemplates) {
      console.log(
        `[instance:${id}] Default templates: ${Object.entries(defaultTemplates.pins)
          .map(([name, pin]) => `${name}@${pin.commit}`)
          .join(", ")}`
      );
    }
    if (targetWorkspace) {
      console.log(
        `[instance:${id}] Opening additional workspace from ${targetWorkspace.sourceCheckout}`
      );
    }
    for (const template of developmentTemplates) {
      console.log(
        `[instance:${id}] Template candidate: ${template.pin.url}@${template.pin.commit} from ${template.sourceCheckout}`
      );
      if (template.changedPaths.length > 0) {
        console.log(
          `[instance:${id}] Template development checkpoint includes ${template.changedPaths.length} worktree change(s).`
        );
      }
    }
    if (!disposable) {
      await prunePersistentInstanceBuildCache(root, id);
    }
    process.exitCode =
      mode === "server"
        ? await runServer(launchArgs, env, instance)
        : await runDesktop(launchArgs, env);
  } finally {
    if (!disposable) await prunePersistentInstanceBuildCache(root, id);
    fs.rmSync(checkpointTarget, { recursive: true, force: true });
    fs.rmSync(templateCheckpointRoot, { recursive: true, force: true });
    const cleanupError = disposable ? removeEphemeralInstanceRoot(root) : null;
    if (cleanupError) {
      // Preserve the registry record and root together: the stale supervisor
      // PID makes the instance unusable, while retaining the exact root makes
      // a leaked descendant diagnosable. Most importantly, cleanup must not
      // replace the hub's original exit status with a bare ENOTEMPTY.
      console.error(
        `[instance:${id}] could not remove ephemeral state ${root}: ${cleanupError.message}`
      );
      process.exitCode = process.exitCode || 1;
    } else {
      unregisterDevInstance(repoRoot, id);
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
  process.exitCode = 1;
});

import fs from "node:fs/promises";
import path from "node:path";
import { inspect } from "node:util";
import { fileURLToPath } from "node:url";
import { resolveActionlint } from "./lib/actionlint.mjs";

export async function checkWorkflows({
  root = process.cwd(),
  resolve = resolveActionlint,
  run,
} = {}) {
  const workflowsDirectory = path.join(root, ".github", "workflows");
  const files = (await fs.readdir(workflowsDirectory))
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .sort()
    .map((name) => path.join(workflowsDirectory, name));
  if (files.length === 0) throw new Error(`No workflow YAML files found in ${workflowsDirectory}.`);

  const executable = await resolve();
  const execute =
    run ??
    ((command, args) =>
      import("node:child_process").then(
        ({ execFile }) =>
          new Promise((resolvePromise, reject) => {
            execFile(command, args, { cwd: root, windowsHide: true }, (error, stdout, stderr) => {
              if (error) {
                error.stdout = stdout;
                error.stderr = stderr;
                reject(error);
              } else resolvePromise({ stdout, stderr });
            });
          })
      ));

  try {
    // This gate covers actionlint's workflow semantics; explicitly disable optional external
    // shellcheck/pyflakes integrations so results do not depend on local tools.
    await execute(executable, ["-color", "-shellcheck=", "-pyflakes=", ...files]);
  } catch (error) {
    const detail = [error.stdout, error.stderr].filter(Boolean).join("\n").trim();
    if (detail) process.stderr.write(`${detail}\n`);
    throw new Error(`actionlint rejected the workflow set (exit ${error.code ?? "unknown"}).`, {
      cause: error,
    });
  }
  return { workflowCount: files.length, executable };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await checkWorkflows();
    process.stdout.write(`actionlint checked ${result.workflowCount} workflows.\n`);
  } catch (error) {
    process.stderr.write(`${inspect(error, { depth: null, colors: false })}\n`);
    process.exitCode = 1;
  }
}

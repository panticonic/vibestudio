import * as path from "node:path";
import { cliConfigRoot } from "./configPaths.js";
import { JSON_FLAG, type CliCommand, type ParsedInvocation } from "./commandTable.js";
import { UsageError, jsonMode, printError, printResult } from "./output.js";
import { resetRuntimeFoundationState } from "../server/runtimeFoundationState.js";

const WORKSPACE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function resolveStatePath(inv: ParsedInvocation): string {
  const explicit = inv.flags["state-path"];
  const workspace = inv.flags["workspace"];
  if (explicit !== undefined && workspace !== undefined) {
    throw new UsageError("use either --workspace or --state-path, not both");
  }
  if (explicit !== undefined) {
    if (typeof explicit !== "string" || explicit.trim().length === 0) {
      throw new UsageError("--state-path requires a directory");
    }
    return path.resolve(explicit);
  }
  const name = typeof workspace === "string" ? workspace : "default";
  if (!WORKSPACE_NAME.test(name)) throw new UsageError("--workspace is not a valid workspace name");
  return path.join(cliConfigRoot(), "workspaces", name, "state");
}

async function reset(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    if (inv.positionals.length > 0)
      throw new UsageError("reset does not accept positional arguments");
    if (inv.flags["confirm"] !== true) {
      throw new UsageError(
        "the scoped reset recreates saved approvals, runtime selections, build products, and diagnostics; review the command help, then pass --confirm"
      );
    }
    const result = resetRuntimeFoundationState(resolveStatePath(inv));
    printResult(result, {
      json,
      human: () => {
        console.log(`Runtime foundations reset to format ${result.formatVersion}.`);
        console.log(`State: ${result.statePath}`);
        for (const category of result.reset) {
          console.log(`  ${category.id}: removed ${category.removed.length} path(s)`);
        }
        console.log(
          "Preserved source/content, contexts, databases, credentials, Git recovery state, and logs."
        );
      },
    });
    return 0;
  } catch (error) {
    return printError(error, { json });
  }
}

export const runtimeFoundationCommands: CliCommand[] = [
  {
    group: "runtime-foundations",
    name: "reset",
    summary: "Reset only incompatible, rebuildable runtime-foundation state",
    usage:
      "vibestudio runtime-foundations reset [--workspace <name> | --state-path <dir>] --confirm [--json]",
    flags: [
      {
        name: "workspace",
        takesValue: true,
        description: "Managed workspace name (default: default)",
      },
      { name: "state-path", takesValue: true, description: "Explicit workspace state directory" },
      { name: "confirm", takesValue: false, description: "Confirm the documented scoped data cut" },
      JSON_FLAG,
    ],
    run: reset,
  },
];

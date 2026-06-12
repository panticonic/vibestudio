import { UsageError } from "./output.js";

/**
 * Declarative CLI command table. Each command belongs to a group
 * (`natstack <group> <name> ...`) and declares its flags up front so a
 * single parser drives dispatch, help text, and unknown-flag rejection.
 *
 * Extension point: later command groups (fs, git, eval, ...) export a
 * `CliCommand[]` and get appended to the registry in client.ts.
 */

export interface FlagSpec {
  /** Flag name without leading dashes, e.g. "ttl-ms". */
  name: string;
  /** Optional single-letter alias, e.g. "R" for `-R`. */
  short?: string;
  /** Whether the flag consumes the next argv token as its value. */
  takesValue: boolean;
  description?: string;
}

export interface ParsedInvocation {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

export interface CliCommand {
  group: string;
  name: string;
  aliases?: string[];
  summary: string;
  usage?: string;
  flags?: FlagSpec[];
  /**
   * Script-runner commands forward argv verbatim to an external script and
   * skip flag validation entirely.
   */
  passthrough?: boolean;
  run: (inv: ParsedInvocation, rawArgs: string[]) => Promise<number>;
}

/** Common --json flag shared by commands that emit structured results. */
export const JSON_FLAG: FlagSpec = {
  name: "json",
  takesValue: false,
  description: "Emit JSON (automatic when stdout is not a TTY)",
};

export function findCommand(
  commands: CliCommand[],
  group: string,
  name: string
): CliCommand | undefined {
  return commands.find(
    (cmd) => cmd.group === group && (cmd.name === name || cmd.aliases?.includes(name))
  );
}

export function groupCommands(commands: CliCommand[], group: string): CliCommand[] {
  return commands.filter((cmd) => cmd.group === group);
}

/**
 * Parse argv against a command's declared flags. Unknown flags are usage
 * errors; everything else is collected as positionals in order.
 */
export function parseInvocation(command: CliCommand, argv: string[]): ParsedInvocation {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    const isLong = arg.startsWith("--");
    const isShort = !isLong && /^-[A-Za-z]$/.test(arg);
    if (isLong || isShort) {
      const spec = isLong
        ? command.flags?.find((flag) => flag.name === arg.slice(2))
        : command.flags?.find((flag) => flag.short === arg.slice(1));
      if (!spec) {
        throw new UsageError(`Unknown flag for ${command.group} ${command.name}: ${arg}`);
      }
      if (spec.takesValue) {
        const value = argv[++i];
        if (value === undefined) throw new UsageError(`Flag ${arg} requires a value`);
        flags[spec.name] = value;
      } else {
        flags[spec.name] = true;
      }
    } else {
      positionals.push(arg);
    }
  }
  return { positionals, flags };
}

/** Render usage lines for one group's commands. */
export function renderGroupHelp(commands: CliCommand[], group: string): string {
  const lines = groupCommands(commands, group).map((cmd) => {
    const usage = cmd.usage ?? `natstack ${cmd.group} ${cmd.name}`;
    return `  ${usage.padEnd(52)} ${cmd.summary}`;
  });
  return lines.join("\n");
}

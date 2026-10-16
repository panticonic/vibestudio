import { TerminalHostState } from "../../hosts/terminal/hostState.js";
import { GROUP_ORDER } from "./commandGroups.js";
import { UsageError } from "./output.js";
import type { CliCommand } from "./commandTable.js";

/**
 * Shell completion. `vibestudio completions <shell>` prints a script whose
 * static words (groups, subcommands, flags) come from the command registry,
 * and whose dynamic words (client commands, `open <id> <intent>`) are asked of
 * `vibestudio completions dynamic <kind>` at Tab time. That reads the terminal
 * host's cached client index from disk and never touches the network.
 */

export const COMPLETION_SHELLS = ["bash", "zsh", "fish"] as const;
export type CompletionShell = (typeof COMPLETION_SHELLS)[number];

export const DYNAMIC_KINDS = ["commands", "clients", "intents"] as const;
export type DynamicKind = (typeof DYNAMIC_KINDS)[number];

/** The words a registry contributes; shell-independent. */
export interface CompletionModel {
  /** Every group with its subcommands (none for a group that is itself the command). */
  groups: Array<{ name: string; subcommands: string[] }>;
  /** `--flag` words by command key: `group` for a group-level command, `group sub` otherwise. */
  flags: Record<string, string[]>;
}

export function completionModel(registry: readonly CliCommand[]): CompletionModel {
  const groups = GROUP_ORDER.map((name) => ({
    name,
    subcommands: registry
      .filter((command) => command.group === name && command.name !== "")
      .map((command) => command.name),
  }));
  const flags: CompletionModel["flags"] = {};
  for (const command of registry) {
    const words = (command.flags ?? []).flatMap((flag) => [
      `--${flag.name}`,
      ...(flag.short ? [`-${flag.short}`] : []),
    ]);
    if (words.length === 0) continue;
    flags[command.name === "" ? command.group : `${command.group} ${command.name}`] = words;
  }
  return { groups, flags };
}

const TOP_LEVEL_WORDS = ["help", "version"];

/** Words the shell function asks of the CLI at Tab time. */
const DYNAMIC = (kind: DynamicKind, arg = ""): string =>
  `vibestudio completions dynamic ${kind}${arg} 2>/dev/null`;

const words = (list: readonly string[]): string => list.join(" ");
const groupsWithSubcommands = (model: CompletionModel) =>
  model.groups.filter((group) => group.subcommands.length > 0);

/** Flag words by command key; a key with a space is `group sub`, else a group-level command. */
function flagEntries(model: CompletionModel, level: "sub" | "group"): Array<[string, string]> {
  return Object.entries(model.flags)
    .filter(([key]) => key.includes(" ") === (level === "sub"))
    .map(([key, flags]) => [key, words(flags)]);
}

/**
 * The shell-neutral decision, written once per shell below: which words
 * complete the word being typed, given the words before it.
 *
 *   -*                    flags of the command named so far
 *   (first word)          groups, help/version, client commands
 *   help _                groups
 *   open _                client ids
 *   open <id> _           that client's intents
 *   <group> _             the group's subcommands
 */
function bashScript(model: CompletionModel): string {
  const subs = groupsWithSubcommands(model)
    .map((group) => `    ${group.name}) candidates="${words(group.subcommands)}" ;;`)
    .join("\n");
  return `# bash completion for vibestudio. Install: eval "$(vibestudio completions bash)"
_vibestudio() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  local -a before=("\${COMP_WORDS[@]:1:COMP_CWORD-1}")
  local candidates=""
  if [[ "$cur" == -* ]]; then
    case "\${before[0]} \${before[1]}" in
${flagEntries(model, "sub").map(([key, flags]) => `      "${key}") candidates="${flags}" ;;`).join("\n")}
      *) case "\${before[0]}" in
${flagEntries(model, "group").map(([key, flags]) => `        "${key}") candidates="${flags}" ;;`).join("\n")}
      esac ;;
    esac
  elif (( \${#before[@]} == 0 )); then
    candidates="${words([...model.groups.map((group) => group.name), ...TOP_LEVEL_WORDS])} $(${DYNAMIC("commands")})"
  elif [[ "\${before[0]}" == help && \${#before[@]} == 1 ]]; then
    candidates="${words(model.groups.map((group) => group.name))}"
  elif [[ "\${before[0]}" == open ]]; then
    if (( \${#before[@]} == 1 )); then
      candidates="$(${DYNAMIC("clients")})"
    elif (( \${#before[@]} == 2 )); then
      candidates="$(${DYNAMIC("intents", ' "\${before[1]}"')})"
    fi
  elif (( \${#before[@]} == 1 )); then
    case "\${before[0]}" in
${subs}
    esac
  fi
  COMPREPLY=($(compgen -W "$candidates" -- "$cur"))
}
complete -F _vibestudio vibestudio
`;
}

function zshScript(model: CompletionModel): string {
  const subs = groupsWithSubcommands(model)
    .map((group) => `      ${group.name}) candidates=(${words(group.subcommands)}) ;;`)
    .join("\n");
  return `#compdef vibestudio
# zsh completion for vibestudio. Install: eval "$(vibestudio completions zsh)"
_vibestudio() {
  local cur="$words[CURRENT]"
  local -a before candidates
  before=("\${(@)words[2,CURRENT-1]}")
  if [[ "$cur" == -* ]]; then
    case "$before[1] $before[2]" in
${flagEntries(model, "sub").map(([key, flags]) => `      "${key}") candidates=(${flags}) ;;`).join("\n")}
      *) case "$before[1]" in
${flagEntries(model, "group").map(([key, flags]) => `        "${key}") candidates=(${flags}) ;;`).join("\n")}
      esac ;;
    esac
  elif (( $#before == 0 )); then
    candidates=(${words([...model.groups.map((group) => group.name), ...TOP_LEVEL_WORDS])} \${(f)"$(${DYNAMIC("commands")})"})
  elif [[ "$before[1]" == help && $#before == 1 ]]; then
    candidates=(${words(model.groups.map((group) => group.name))})
  elif [[ "$before[1]" == open ]]; then
    if (( $#before == 1 )); then
      candidates=(\${(f)"$(${DYNAMIC("clients")})"})
    elif (( $#before == 2 )); then
      candidates=(\${(f)"$(${DYNAMIC("intents", ' "$before[2]"')})"})
    fi
  elif (( $#before == 1 )); then
    case "$before[1]" in
${subs}
    esac
  fi
  compadd -- $candidates
}
if [[ "$funcstack[1]" == _vibestudio ]]; then _vibestudio "$@"; else compdef _vibestudio vibestudio; fi
`;
}

function fishScript(model: CompletionModel): string {
  const subs = groupsWithSubcommands(model)
    .map((group) => `      case ${group.name}\n        printf '%s\\n' ${words(group.subcommands)}`)
    .join("\n");
  return `# fish completion for vibestudio. Install: vibestudio completions fish | source
function __vibestudio_candidates
  set -l before (commandline -opc)[2..-1]
  set -l cur (commandline -ct)
  if string match -q -- '-*' $cur
    switch "$before[1] $before[2]"
${flagEntries(model, "sub").map(([key, flags]) => `      case '${key}'\n        printf '%s\\n' ${flags}`).join("\n")}
      case '*'
        switch "$before[1]"
${flagEntries(model, "group").map(([key, flags]) => `          case '${key}'\n            printf '%s\\n' ${flags}`).join("\n")}
        end
    end
  else if test (count $before) -eq 0
    printf '%s\\n' ${words([...model.groups.map((group) => group.name), ...TOP_LEVEL_WORDS])}
    ${DYNAMIC("commands")}
  else if test "$before[1]" = help -a (count $before) -eq 1
    printf '%s\\n' ${words(model.groups.map((group) => group.name))}
  else if test "$before[1]" = open
    if test (count $before) -eq 1
      ${DYNAMIC("clients")}
    else if test (count $before) -eq 2
      vibestudio completions dynamic intents $before[2] 2>/dev/null
    end
  else if test (count $before) -eq 1
    switch "$before[1]"
${subs}
    end
  end
end
complete -c vibestudio -f -a '(__vibestudio_candidates)'
`;
}

export function renderCompletionScript(shell: CompletionShell, model: CompletionModel): string {
  switch (shell) {
    case "bash":
      return bashScript(model);
    case "zsh":
      return zshScript(model);
    case "fish":
      return fishScript(model);
  }
}

/**
 * The cached, per-device words behind the dynamic completions. A missing or
 * unreadable cache completes nothing: Tab must never fail or reach the network.
 */
export function dynamicCompletions(
  state: TerminalHostState,
  kind: DynamicKind,
  clientId?: string
): string[] {
  let data;
  try {
    data = state.read();
  } catch {
    return [];
  }
  switch (kind) {
    case "commands":
      return Object.keys(data.commands);
    case "clients":
      return Object.keys(data.clients);
    case "intents":
      return clientId ? (data.clients[clientId]?.intents ?? []) : [];
  }
}

export function createCompletionsCommand(deps: {
  registry: () => readonly CliCommand[];
  state: () => TerminalHostState;
}): CliCommand {
  return {
    group: "completions",
    name: "",
    summary: "Print a shell completion script (bash, zsh, or fish)",
    usage: `vibestudio completions <${COMPLETION_SHELLS.join("|")}>`,
    details: `Install with \`eval "$(vibestudio completions bash)"\` (or zsh), or
\`vibestudio completions fish | source\`. Client commands and \`open <client>
<intent>\` complete from the client list this device last fetched, read from
disk with no network call; \`vibestudio clients list\` refreshes it.

\`vibestudio completions dynamic <commands|clients|intents> [client]\` is what
the scripts call at Tab time.`,
    run: async (inv) => {
      const [first, ...rest] = inv.positionals;
      if (first === "dynamic") {
        const [kind, clientId] = rest;
        if (!DYNAMIC_KINDS.includes(kind as DynamicKind)) {
          throw new UsageError(`Usage: vibestudio completions dynamic <${DYNAMIC_KINDS.join("|")}>`);
        }
        const out = dynamicCompletions(deps.state(), kind as DynamicKind, clientId);
        if (out.length > 0) process.stdout.write(`${out.join("\n")}\n`);
        return 0;
      }
      if (!COMPLETION_SHELLS.includes(first as CompletionShell) || rest.length > 0) {
        throw new UsageError(`Usage: vibestudio completions <${COMPLETION_SHELLS.join("|")}>`);
      }
      process.stdout.write(
        renderCompletionScript(first as CompletionShell, completionModel(deps.registry()))
      );
      return 0;
    },
  };
}

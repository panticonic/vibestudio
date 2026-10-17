import { isBuiltInCommand } from "../../hosts/terminal/clientShims.js";

/** Every command group, in help order, with its one-line description. */
export const GROUP_DESCRIPTIONS: Record<string, string> = {
  remote: "pairing, servers, workspaces, and remote hosts",
  terminal: "open the terminal browser, starting a local server when needed",
  open: "open a terminal client by id, or run one of its background intents",
  clients: "list terminal clients and put their commands in ~/.local/bin",
  completions: "print a bash, zsh, or fish completion script",
  mobile: "develop, install, inspect, and pair mobile clients",
  model: "connect and renew model-provider credentials",
  agent: "sessions, diagnostics, services, and workspace skills",
  approvals: "list, decide, and follow pending hub and workspace approval requests",
  fs: "read and edit files in the active agent context",
  vcs: "inspect, commit, merge, and push workspace repositories",
  templates: "discover, inspect, author, and publish workspace templates",
  workspace: "maintain checked-in workspace source declarations",
  eval: "run sandboxed code in the active agent context",
  channel: "list, read, send, and follow conversation channels",
  context: "materialize and watch remote context folders",
  panel: "inspect and capture workspace panels",
  "system-test": "run and inspect headless agentic system tests on a paired instance",
  storage: "inspect and prune regenerable caches",
};
export const GROUP_ORDER = Object.keys(GROUP_DESCRIPTIONS);

/** Names the CLI itself defines, now or later: a client command or shim never takes one. */
export const isCliBuiltInCommand = isBuiltInCommand(GROUP_ORDER);

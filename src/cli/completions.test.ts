import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TerminalHostState } from "../../hosts/terminal/hostState.js";
import {
  completionModel,
  createCompletionsCommand,
  dynamicCompletions,
  renderCompletionScript,
  type CompletionShell,
} from "./completions.js";
import { GROUP_ORDER } from "./commandGroups.js";
import type { CliCommand } from "./commandTable.js";

const run = async () => 0;
const registry: CliCommand[] = [
  { group: "remote", name: "pair", summary: "", flags: [{ name: "label", takesValue: true }], run },
  { group: "remote", name: "list", summary: "", run },
  {
    group: "open",
    name: "",
    summary: "",
    flags: [
      { name: "develop", takesValue: false },
      { name: "yes", short: "y", takesValue: false },
    ],
    run,
  },
  { group: "clients", name: "list", summary: "", run },
];

const dirs: string[] = [];
function stateWith(data: object | null): TerminalHostState {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vs-completions-"));
  dirs.push(dir);
  const file = path.join(dir, "terminal-host.json");
  if (data) fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, ...data }));
  return new TerminalHostState(file);
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("completion model", () => {
  const model = completionModel(registry);
  it("lists every group, with subcommands only for groups that have them", () => {
    expect(model.groups.map((group) => group.name)).toEqual(GROUP_ORDER);
    expect(model.groups.find((group) => group.name === "remote")?.subcommands).toEqual([
      "pair",
      "list",
    ]);
    expect(model.groups.find((group) => group.name === "open")?.subcommands).toEqual([]);
  });
  it("keys flags by command, including short aliases", () => {
    expect(model.flags).toEqual({
      "remote pair": ["--label"],
      open: ["--develop", "--yes", "-y"],
    });
  });
});

describe("scripts", () => {
  const model = completionModel(registry);
  it.each(["bash", "zsh", "fish"] as CompletionShell[])(
    "%s script carries groups, subcommands, flags and the dynamic lookups",
    (shell) => {
      const script = renderCompletionScript(shell, model);
      for (const word of ["remote", "completions", "pair", "--label", "--develop"]) {
        expect(script).toContain(word);
      }
      expect(script).toContain("completions dynamic commands");
      expect(script).toContain("completions dynamic clients");
      expect(script).toContain("completions dynamic intents");
    }
  );
  it("never calls the network at Tab time", () => {
    for (const shell of ["bash", "zsh", "fish"] as CompletionShell[]) {
      expect(renderCompletionScript(shell, model)).not.toMatch(/clients (list|launch)|curl|wget/);
    }
  });
});

describe("bash script behaviour", () => {
  const model = completionModel(registry);
  /** Run the generated function with a stub `vibestudio` serving the dynamic words. */
  function complete(...words: string[]): string[] {
    const script = renderCompletionScript("bash", model);
    const harness = `
vibestudio() {
  [[ "$1 $2" == "completions dynamic" ]] || return 1
  case "$3" in
    commands) printf 'chat\\nnotes\\n' ;;
    clients) printf 'chat\\nnotes\\n' ;;
    intents) [[ "$4" == chat ]] && printf 'open\\nask\\n' ;;
  esac
}
complete() { :; }
${script}
COMP_WORDS=(vibestudio ${words.map((w) => `'${w}'`).join(" ")})
COMP_CWORD=$((\${#COMP_WORDS[@]} - 1))
_vibestudio
printf '%s\\n' "\${COMPREPLY[@]}"`;
    return execFileSync("bash", ["-c", harness], { encoding: "utf8" }).split("\n").filter(Boolean);
  }
  it("completes groups, built-ins and the client command table", () => {
    const all = complete("");
    expect(all).toEqual(
      expect.arrayContaining(["remote", "open", "completions", "help", "chat", "notes"])
    );
    expect(complete("c")).toEqual(expect.arrayContaining(["clients", "completions", "chat"]));
    expect(complete("c")).not.toContain("remote");
  });
  it("completes subcommands, flags, and open <id> <intent>", () => {
    expect(complete("remote", "")).toEqual(["pair", "list"]);
    expect(complete("remote", "pair", "--")).toEqual(["--label"]);
    expect(complete("open", "")).toEqual(["chat", "notes"]);
    expect(complete("open", "chat", "")).toEqual(["open", "ask"]);
    expect(complete("open", "chat", "a")).toEqual(["ask"]);
    expect(complete("open", "chat", "--d")).toEqual(["--develop"]);
    expect(complete("help", "")).toContain("remote");
  });
});

describe("dynamic completions", () => {
  it("reads the cached index", () => {
    const state = stateWith({
      commands: { chat: { clientId: "chat" } },
      clients: { chat: { intents: ["open", "ask"] }, notes: { intents: ["open"] } },
    });
    expect(dynamicCompletions(state, "commands")).toEqual(["chat"]);
    expect(dynamicCompletions(state, "clients")).toEqual(["chat", "notes"]);
    expect(dynamicCompletions(state, "intents", "chat")).toEqual(["open", "ask"]);
    expect(dynamicCompletions(state, "intents", "missing")).toEqual([]);
    expect(dynamicCompletions(state, "intents")).toEqual([]);
  });
  it("completes nothing, without failing, when there is no usable cache", () => {
    expect(dynamicCompletions(stateWith(null), "clients")).toEqual([]);
    const broken = stateWith({});
    fs.writeFileSync((broken as unknown as { file: string }).file, "{ not json");
    expect(dynamicCompletions(broken, "commands")).toEqual([]);
  });
});

describe("completions command", () => {
  const command = createCompletionsCommand({
    registry: () => registry,
    state: () => stateWith({}),
  });
  const invoke = (...positionals: string[]) =>
    command.run({ positionals, flags: {}, flagsMulti: () => [] }, positionals);
  it("rejects an unknown shell and a bad dynamic kind", async () => {
    await expect(invoke("powershell")).rejects.toThrow(/Usage: vibestudio completions/);
    await expect(invoke()).rejects.toThrow(/Usage/);
    await expect(invoke("dynamic", "nope")).rejects.toThrow(/Usage/);
  });
});

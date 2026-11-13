import { describe, expect, it } from "vitest";
import {
  JSON_FLAG,
  parseInvocation,
  renderCommandHelp,
  renderGroupHelp,
  type CliCommand,
} from "./commandTable.js";

const command: CliCommand = {
  group: "remote",
  name: "deploy",
  summary: "Deploy a server",
  usage: "vibestudio remote deploy <very long detailed usage that belongs in command help>",
  flags: [JSON_FLAG],
  run: async () => 0,
};

describe("CLI help and output flags", () => {
  it("keeps group help aligned by showing compact command names", () => {
    const help = renderGroupHelp([command], "remote");
    expect(help).toContain("vibestudio remote deploy");
    expect(help).toContain("Deploy a server");
    expect(help).not.toContain("very long detailed usage");
  });

  it("aligns summaries past the longest command name in a group", () => {
    const long: CliCommand = {
      ...command,
      name: "ensure-user-workspaces-and-more",
      summary: "Long",
    };
    const lines = renderGroupHelp([command, long], "remote").split("\n");
    const columns = lines.map((line) => line.indexOf(line.includes("Long") ? "Long" : "Deploy"));
    expect(new Set(columns).size).toBe(1);
  });

  it("accepts and documents --plain for structured commands", () => {
    expect(parseInvocation(command, ["--plain"]).flags).toMatchObject({ plain: true });
    expect(renderCommandHelp(command)).toContain("--plain");
  });

  it("rejects positionals past the declared ones and accepts variadic tails", () => {
    expect(() => parseInvocation(command, ["extra"])).toThrow(/takes no arguments/);
    const one: CliCommand = { ...command, args: [{ name: "ID" }] };
    expect(parseInvocation(one, ["a"]).positionals).toEqual(["a"]);
    expect(() => parseInvocation(one, ["a", "b"])).toThrow(/Unexpected argument.*"b"/);
    const many: CliCommand = { ...command, args: [{ name: "NAME", variadic: true }] };
    expect(parseInvocation(many, ["a", "b", "c"]).positionals).toEqual(["a", "b", "c"]);
    expect(renderCommandHelp({ ...many, usage: undefined })).toContain(
      "vibestudio remote deploy NAME..."
    );
  });
});

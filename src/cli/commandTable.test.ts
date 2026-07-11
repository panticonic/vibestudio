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

  it("accepts and documents --plain for structured commands", () => {
    expect(parseInvocation(command, ["--plain"]).flags).toMatchObject({ plain: true });
    expect(renderCommandHelp(command)).toContain("--plain");
  });
});

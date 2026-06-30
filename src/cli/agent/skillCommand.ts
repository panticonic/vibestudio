import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { JSON_FLAG, type CliCommand, type ParsedInvocation } from "../commandTable.js";
import { CliError, UsageError, jsonMode, printError, printResult } from "../output.js";

/**
 * `vibez1 agent skill install|print` — install (or print) the bundled
 * vibez1-agent Claude Code skill that documents this CLI.
 */

const SKILL_NAME = "vibez1-agent";
const DEFAULT_INSTALL_DIR = path.join(".claude", "skills", SKILL_NAME);

/**
 * Locate the bundled skill directory. Built CLI: build.mjs copies
 * skills/vibez1-agent next to client.mjs (dist/cli/skills/vibez1-agent).
 * Dev (tsx on src/): falls back to <repoRoot>/skills/vibez1-agent.
 * VIBEZ1_AGENT_SKILL_DIR overrides (test seam).
 */
export function resolveSkillDir(): string {
  const override = process.env["VIBEZ1_AGENT_SKILL_DIR"];
  if (override) return override;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "skills", SKILL_NAME), // bundled: dist/cli/client.mjs sibling
    path.resolve(here, "..", "..", "..", "skills", SKILL_NAME), // dev: src/cli/agent -> repo root
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, "SKILL.md"))) return candidate;
  }
  throw new CliError(`bundled skill not found (looked in ${candidates.join(", ")})`);
}

async function install(inv: ParsedInvocation, json: boolean): Promise<number> {
  const source = resolveSkillDir();
  const dir = typeof inv.flags["dir"] === "string" ? inv.flags["dir"] : DEFAULT_INSTALL_DIR;
  const dest = path.resolve(dir);
  fs.cpSync(source, dest, { recursive: true });
  const files = fs
    .readdirSync(dest)
    .filter((entry) => entry.endsWith(".md"))
    .sort();
  printResult(
    { installed: dest, files },
    {
      json,
      human: () => {
        console.log(`installed ${SKILL_NAME} skill to ${dest}`);
        for (const file of files) console.log(`  ${file}`);
      },
    }
  );
  return 0;
}

async function print(explicitJson: boolean): Promise<number> {
  const content = fs.readFileSync(path.join(resolveSkillDir(), "SKILL.md"), "utf8");
  // Raw markdown by default (even when piped, like `fs read`); --json wraps it.
  if (explicitJson) printResult(content, { json: true });
  else process.stdout.write(content);
  return 0;
}

async function skill(inv: ParsedInvocation): Promise<number> {
  const json = jsonMode(inv.flags["json"] === true);
  try {
    const action = inv.positionals[0];
    switch (action) {
      case "install":
        return await install(inv, json);
      case "print":
        return await print(inv.flags["json"] === true);
      default:
        throw new UsageError("usage: vibez1 agent skill install [--dir DIR] | print");
    }
  } catch (error) {
    return printError(error, { json });
  }
}

export const skillCommand: CliCommand = {
  group: "agent",
  name: "skill",
  summary: "Install or print the bundled vibez1-agent Claude Code skill",
  usage: "vibez1 agent skill install [--dir DIR] | print",
  flags: [
    {
      name: "dir",
      takesValue: true,
      description: `Install directory (default: ${DEFAULT_INSTALL_DIR})`,
    },
    JSON_FLAG,
  ],
  run: skill,
};

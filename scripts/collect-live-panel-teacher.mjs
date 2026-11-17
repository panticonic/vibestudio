#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  requireDevelopmentTemplateCheckouts,
  developmentTemplateHead,
} from "../src/dev/developmentTemplateConfig.cjs";
import { exportLivePanelTeacher } from "./export-live-panel-teacher.mjs";

const args = process.argv.slice(2);
const { values } = parseArgs({
  args: args[0] === "--" ? args.slice(1) : args,
  options: {
    case: { type: "string" },
    out: { type: "string" },
    model: { type: "string", default: "openai-codex:gpt-6-luna" },
  },
});
const scenario = values.case;
if (!["panel-draft-unmount", "panel-draft-stale-snapshot"].includes(scenario) || !values.out) {
  throw new Error(
    "Usage: pnpm natlang:teacher --case PANEL_CASE --out NEW_DIR [--model PROVIDER:MODEL]"
  );
}

const host = fileURLToPath(new URL("../", import.meta.url));
const { checkouts } = requireDevelopmentTemplateCheckouts(host);
const validator = path.join(
  checkouts["system-testing"],
  "skills/system-testing/panel-repair-oracle.ts"
);
const runtimePin = path.join(checkouts.base, "packages/natlang/vendor/natlang-pin.json");
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const git = (...args) => execFileSync("git", args, { cwd: host, encoding: "utf8" }).trim();

function pinSources() {
  const entries = Object.entries(checkouts).map(([name, dir]) => {
    const source = developmentTemplateHead(dir);
    return [name, { git_commit: source.commit, dirty: source.dirty }];
  });
  const runtime = readJson(runtimePin);
  const repositories = {
    vibestudio: {
      git_commit: git("rev-parse", "HEAD"),
      dirty: Boolean(git("status", "--porcelain", "-uno")),
    },
    natlang: { git_commit: runtime.commit, dirty: runtime.dirty },
    ...Object.fromEntries(entries),
  };
  for (const [name, revision] of Object.entries(repositories)) {
    if (revision.dirty !== false || !/^[a-f0-9]{40}$/u.test(revision.git_commit)) {
      throw new Error(`The live run requires a clean source pin for ${name}`);
    }
  }
  return {
    repositories,
    validator_sha256: createHash("sha256").update(readFileSync(validator)).digest("hex"),
  };
}

function command(args, stdout = "inherit") {
  const result = spawnSync("pnpm", args, { cwd: host, stdio: ["inherit", stdout, "inherit"] });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

const pinned = pinSources();
if (command(["natlang:vendor", "--check"]) !== 0)
  throw new Error("Vendored Natlang pin check failed");
const out = path.resolve(values.out);
mkdirSync(out, { mode: 0o700 });
const instance = `natlang-live-${randomUUID().slice(0, 12)}`;
const systemTest = (args, stdout) =>
  command(["system-test", "--instance", instance, ...args], stdout);
const pins = path.join(out, "source.json");
const source = { ...pinned, instance, teacher: values.model };
writeFileSync(pins, JSON.stringify(source, null, 2), { mode: 0o600, flag: "wx" });
try {
  if (systemTest(["doctor", "--approve-startup", "--model", source.teacher]) !== 0) {
    throw new Error("The managed Vibestudio instance did not pass readiness checks");
  }
  const status = systemTest(["run", scenario, "--model", source.teacher, "--out-dir", out]);
  const runs = readdirSync(out).filter((entry) => /^st_[a-f0-9]{32}$/u.test(entry));
  if (runs.length !== 1) throw new Error("Expected one managed system-test run");
  const [runId] = runs;
  writeFileSync(pins, JSON.stringify({ ...source, run_id: runId }, null, 2));
  if (status !== 0) throw new Error(`System test ${runId} failed. Its evidence is in ${out}`);
  if (
    systemTest(["trajectory", runId, scenario, "--full", "--json", "--out-dir", out], "ignore") !==
    0
  ) {
    throw new Error(`Unable to retrieve the durable trajectory for ${runId}`);
  }
  if (JSON.stringify(pinSources()) !== JSON.stringify(pinned)) {
    throw new Error("Source pins changed during the live run");
  }
  const destination = path.join(out, "verified");
  await exportLivePanelTeacher({
    trajectory: path.join(out, runId, `trajectory-${scenario}-full.json.gz`),
    pins,
    validator,
    out: destination,
    split: "train",
  });
  console.log(path.join(destination, "manifest.json"));
} finally {
  if (systemTest(["stop"]) !== 0) process.exitCode = 1;
}

#!/usr/bin/env node
/**
 * Vendor natlang into the template checkouts that consume it, and verify what is vendored.
 *
 * natlang is not published to npm. Base's `@workspace/natlang` (the workerd core with TypeScript bundled in), the natlang dashboard assets, and
 * System's `local-models` extension (llama manager) each carry generated bundles staged by natlang's own script
 * (`ts-host/scripts/stage-vibestudio.mjs`) from one pinned natlang commit, written beside a `natlang-pin.json` that
 * names the commit and every file's sha256. Vendored output is never edited by hand: run this script again.
 *
 *   pnpm natlang:vendor [--commit REF]
 *       Stage the workerd, dashboard and llama bundles of REF (default origin/main of NATLANG_REPO, ~/natlang) into the
 *       vendored directories below, from a temporary git worktree.
 *   pnpm natlang:vendor --check
 *       Hermetic: every vendored directory exists, has a well-formed pin of a clean commit, and its files match the
 *       pin exactly (no edited, missing or extra file). This is the gate in `check:commit`.
 *   pnpm natlang:vendor --check --reproduce
 *       Also rebuild each pinned commit with that commit's own build scripts and compare byte for byte. Needs the
 *       natlang repository (NATLANG_REPO) to contain the pinned commits.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  checkVendoredNatlang,
  natlangRepository,
  stageInWorktree,
  withNatlangWorktree,
} from "./lib/natlang-stage.mjs";

const PIN = "natlang-pin.json";
const PIN_SCHEMA = "natlang.vendor-pin/1";

/** Where each natlang target is vendored: the template that consumes it, and the directory (the pin's root) in it. */
export const VENDORED_TARGETS = [
  { target: "workerd", template: "base", directory: "packages/natlang/vendor" },
  { target: "pi", template: "base", directory: "packages/natlang-pi/vendor" },
  { target: "evaluation", template: "base", directory: "packages/natlang/vendor-evaluation" },
  { target: "dashboard", template: "base", directory: "packages/natlang/vendor-dashboard" },
  { target: "llama", template: "system", directory: "extensions/local-models/vendor" },
];

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function templateCheckouts() {
  const { requireDevelopmentTemplateCheckouts } = createRequire(import.meta.url)(
    "../src/dev/developmentTemplateConfig.cjs"
  );
  return requireDevelopmentTemplateCheckouts(repoRoot).checkouts;
}

function vendoredDirectory(checkouts, entry) {
  const checkout = checkouts[entry.template];
  if (!checkout) throw new Error(`no ${entry.template} template checkout is configured`);
  return path.join(checkout, entry.directory);
}

function filesUnder(directory) {
  const found = [];
  (function walk(at) {
    for (const name of fs.readdirSync(at)) {
      const file = path.join(at, name);
      if (fs.statSync(file).isDirectory()) walk(file);
      else found.push(path.relative(directory, file).split(path.sep).join("/"));
    }
  })(directory);
  return found.sort();
}

const sha256 = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");

/** The differences between a vendored directory and its own pin. */
export function integrityProblems(directory, target) {
  const pinPath = path.join(directory, PIN);
  if (!fs.existsSync(pinPath)) return [`${pinPath} does not exist; run pnpm natlang:vendor`];
  const pin = JSON.parse(fs.readFileSync(pinPath, "utf8"));
  const problems = [];
  if (pin.schema !== PIN_SCHEMA)
    problems.push(`${PIN} has schema ${pin.schema}; expected ${PIN_SCHEMA}`);
  if (pin.dirty !== false) problems.push(`${PIN} records a dirty natlang tree`);
  if (typeof pin.commit !== "string" || !/^[0-9a-f]{40}$/.test(pin.commit)) {
    problems.push(`${PIN} names no commit`);
  }
  if (!Array.isArray(pin.targets) || pin.targets.length !== 1 || pin.targets[0] !== target) {
    problems.push(
      `${PIN} is for targets ${JSON.stringify(pin.targets)}; expected [${JSON.stringify(target)}]`
    );
  }
  const listed = Object.keys(pin.files ?? {});
  for (const file of listed) {
    const absolute = path.join(directory, file);
    if (!fs.existsSync(absolute)) problems.push(`missing: ${file}`);
    else if (sha256(absolute) !== pin.files[file]) problems.push(`edited since staging: ${file}`);
  }
  for (const file of filesUnder(directory)) {
    if (file !== PIN && !listed.includes(file)) problems.push(`not in the pin: ${file}`);
  }
  return problems;
}

async function check({ reproduce }) {
  const checkouts = templateCheckouts();
  const failures = [];
  for (const entry of VENDORED_TARGETS) {
    const directory = vendoredDirectory(checkouts, entry);
    const label = `${entry.template}/${entry.directory}`;
    if (!fs.existsSync(directory)) {
      failures.push(`${label}: not vendored; run pnpm natlang:vendor`);
      continue;
    }
    const problems = integrityProblems(directory, entry.target);
    if (reproduce && problems.length === 0) {
      try {
        await checkVendoredNatlang({ repository: natlangRepository(), dir: directory });
      } catch (error) {
        problems.push(error instanceof Error ? error.message : String(error));
      }
    }
    for (const problem of problems) failures.push(`${label}: ${problem}`);
  }
  if (failures.length > 0) {
    console.error(
      `vendored natlang is not fresh:\n${failures.map((line) => `  ${line}`).join("\n")}`
    );
    process.exit(1);
  }
  console.log(
    `vendored natlang matches its pins${reproduce ? " and fresh builds of their commits" : ""}`
  );
}

async function vendor({ commit }) {
  const checkouts = templateCheckouts();
  await withNatlangWorktree(natlangRepository(), commit, async (tsHost, resolved) => {
    for (const entry of VENDORED_TARGETS) {
      await stageInWorktree(tsHost, {
        only: entry.target,
        out: vendoredDirectory(checkouts, entry),
      });
    }
    console.log(`vendored natlang ${resolved}`);
  });
}

function parseArguments(argv) {
  const options = { check: false, reproduce: false, commit: "origin/main" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--check") options.check = true;
    else if (argument === "--reproduce") options.reproduce = true;
    else if (argument === "--commit") {
      const value = argv[(index += 1)];
      if (!value || value.startsWith("--")) throw new Error("--commit requires a ref");
      options.commit = value;
    } else
      throw new Error(
        `Unknown option ${JSON.stringify(argument)}; use --check, --reproduce or --commit`
      );
  }
  if (options.reproduce && !options.check) throw new Error("--reproduce is a mode of --check");
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArguments(process.argv.slice(2));
    await (options.check ? check(options) : vendor(options));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

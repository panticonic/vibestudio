import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeHostBuildFingerprint,
  sameHostBuildFingerprint,
} from "./host-build-fingerprint.mjs";
import {
  readCurrentHostBuildGeneration,
  releaseHostBuildGeneration,
} from "./host-build-generations.mjs";
import {
  INFRASTRUCTURE_CACHE_PATH,
  inspectInfrastructurePackageBuilds,
} from "./infrastructure-package-cache.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const receiptPath = path.join(repoRoot, ".cache/darwin-host-inputs.json");
const require = createRequire(import.meta.url);

function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function gitOutput(args, cwd = repoRoot) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function assertSourceCheckout(sourceSHA) {
  if (gitOutput(["rev-parse", "HEAD"]) !== sourceSHA) {
    throw new Error("Host release inputs must be produced from the exact source commit");
  }
  if (gitOutput(["status", "--porcelain"])) {
    throw new Error("Host release inputs cannot be produced from a dirty source checkout");
  }
}

function parseArguments(argv) {
  const [action, ...rest] = argv;
  if (action !== "write" && action !== "verify") {
    throw new Error(
      "Usage: ci-host-build-inputs.mjs <write|verify> --source-sha SHA [--desktop-mode MODE] [--source-mode MODE]"
    );
  }
  const options = new Map();
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (!key?.startsWith("--") || !value || value.startsWith("--") || options.has(key)) {
      throw new Error(`Invalid host input option: ${key ?? "<missing>"}`);
    }
    options.set(key, value);
  }
  const sourceSHA = options.get("--source-sha");
  if (!/^[a-f0-9]{40}$/u.test(sourceSHA ?? "")) {
    throw new Error("--source-sha must be a full lowercase Git commit SHA");
  }
  const modes = Object.fromEntries(
    ["desktop", "source"]
      .map((kind) => [kind, options.get(`--${kind}-mode`)])
      .filter(([, mode]) => mode !== undefined)
  );
  if (
    Object.keys(modes).length === 0 ||
    Object.values(modes).some((mode) => !["development", "production"].includes(mode))
  ) {
    throw new Error("At least one valid --desktop-mode or --source-mode is required");
  }
  for (const key of options.keys()) {
    if (
      key !== "--source-sha" &&
      key !== "--desktop-mode" &&
      key !== "--source-mode" &&
      key !== "--template-root"
    ) {
      throw new Error(`Unknown host input option: ${key}`);
    }
  }
  const templateRoot = options.get("--template-root");
  if (templateRoot && !path.isAbsolute(templateRoot)) {
    throw new Error("--template-root must be an absolute checkout root");
  }
  return { action, sourceSHA, modes, templateRoot };
}

function templateSources(templateRoot) {
  if (!templateRoot) return undefined;
  const config = require(path.join(repoRoot, "src/dev/developmentTemplateConfig.cjs"));
  const selection = config.selectDevelopmentTemplateCheckouts(repoRoot, {
    explicitRoot: templateRoot,
  });
  if (!selection) throw new Error("The development template selection is unavailable");
  return Object.fromEntries(
    selection.sources.map((source) => {
      const checkout = selection.checkouts[source.id];
      const head = config.developmentTemplateHead(checkout);
      if (head.dirty) {
        throw new Error(`Template source ${source.id} has uncommitted or untracked changes`);
      }
      const tree = gitOutput(["rev-parse", "HEAD^{tree}"], checkout);
      return [source.id, { commit: head.commit, tree }];
    })
  );
}

function infrastructureReceiptDigest() {
  const file = path.join(repoRoot, INFRASTRUCTURE_CACHE_PATH);
  if (!fs.statSync(file).isFile()) throw new Error("Infrastructure build receipt is missing");
  const plan = inspectInfrastructurePackageBuilds({ cwd: repoRoot });
  if (plan.dirty.length > 0) {
    throw new Error(
      `Infrastructure build outputs are not current: ${plan.dirty
        .map((state) => `${state.name} (${state.reason})`)
        .join(", ")}`
    );
  }
  return sha256(file);
}

function currentGeneration(kind, mode) {
  const root = readCurrentHostBuildGeneration(repoRoot, kind);
  try {
    const record = JSON.parse(
      fs.readFileSync(path.join(repoRoot, "dist/host-generations", `current-${kind}.json`), "utf8")
    );
    const expected = computeHostBuildFingerprint({ cwd: repoRoot, mode });
    if (record.mode !== mode || !sameHostBuildFingerprint(record, expected)) {
      throw new Error(
        `Current ${kind} host generation does not match ${mode} inputs for this checkout`
      );
    }
    return {
      mode,
      fingerprint: record.fingerprint,
      inputCount: record.inputCount,
    };
  } finally {
    releaseHostBuildGeneration(root);
  }
}

const { action, sourceSHA, modes, templateRoot } = parseArguments(process.argv.slice(2));
assertSourceCheckout(sourceSHA);
const generations = Object.fromEntries(
  Object.entries(modes).map(([kind, mode]) => [kind, currentGeneration(kind, mode)])
);
const infrastructureReceiptSha256 = infrastructureReceiptDigest();
const templates = templateSources(templateRoot);

if (action === "write") {
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  fs.writeFileSync(
    receiptPath,
    `${JSON.stringify(
      {
        format: "vibestudio-host-release-inputs/2",
        sourceSHA,
        generations,
        infrastructureReceiptSha256,
        ...(templates ? { templates } : {}),
      },
      null,
      2
    )}\n`,
    { mode: 0o600 }
  );
  process.stdout.write(`Verified host input receipt for ${sourceSHA}\n`);
} else {
  const receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  if (
    receipt.format !== "vibestudio-host-release-inputs/2" ||
    receipt.sourceSHA !== sourceSHA ||
    JSON.stringify(receipt.generations) !== JSON.stringify(generations) ||
    receipt.infrastructureReceiptSha256 !== infrastructureReceiptSha256 ||
    JSON.stringify(receipt.templates) !== JSON.stringify(templates)
  ) {
    throw new Error("Host release inputs do not match this source SHA and current checkout");
  }
  process.stdout.write(`Host input receipt verified for ${sourceSHA}\n`);
}

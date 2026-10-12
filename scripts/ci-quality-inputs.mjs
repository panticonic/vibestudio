import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import {
  INFRASTRUCTURE_CACHE_PATH,
  inspectInfrastructurePackageBuilds,
} from "./infrastructure-package-cache.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const receiptPath = path.join(root, ".cache/ci-quality-inputs.json");
const require = createRequire(import.meta.url);

function git(cwd, ...args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function actualInputs(sourceSHA, templateRoot) {
  if (git(root, "rev-parse", "HEAD") !== sourceSHA) {
    throw new Error("Quality inputs belong to a different host source commit");
  }
  const infrastructure = inspectInfrastructurePackageBuilds({ cwd: root });
  if (infrastructure.dirty.length > 0) {
    throw new Error(
      `Infrastructure outputs are missing or stale: ${infrastructure.dirty
        .map((entry) => `${entry.name} (${entry.reason})`)
        .join(", ")}`
    );
  }
  const infrastructureReceipt = fs.readFileSync(path.join(root, INFRASTRUCTURE_CACHE_PATH));
  const config = require(path.join(root, "src/dev/developmentTemplateConfig.cjs"));
  const selection = config.selectDevelopmentTemplateCheckouts(root, {
    explicitRoot: templateRoot,
  });
  if (!selection) throw new Error("Quality template checkouts are unavailable");
  const templates = Object.fromEntries(
    selection.sources.map(({ id }) => {
      const checkout = selection.checkouts[id];
      const head = config.developmentTemplateHead(checkout);
      if (head.dirty) throw new Error(`Template ${id} has local changes`);
      return [id, { commit: head.commit, tree: git(checkout, "rev-parse", "HEAD^{tree}") }];
    })
  );
  return {
    format: "vibestudio-ci-quality-inputs/1",
    sourceSHA,
    infrastructureReceiptSha256: createHash("sha256").update(infrastructureReceipt).digest("hex"),
    templates,
  };
}

const [action, sourceSHA, templateRoot] = process.argv.slice(2);
if (
  !["write", "verify"].includes(action) ||
  !/^[a-f0-9]{40}$/u.test(sourceSHA ?? "") ||
  !templateRoot ||
  !path.isAbsolute(templateRoot)
) {
  throw new Error("Usage: ci-quality-inputs.mjs <write|verify> SOURCE_SHA ABSOLUTE_TEMPLATE_ROOT");
}
const actual = actualInputs(sourceSHA, templateRoot);
if (action === "write") {
  fs.mkdirSync(path.dirname(receiptPath), { recursive: true });
  fs.writeFileSync(receiptPath, `${JSON.stringify(actual, null, 2)}\n`, { mode: 0o600 });
} else {
  const expected = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error("Quality inputs do not match the producer's exact host and template set");
  }
}
process.stdout.write(
  `Quality inputs ${action === "write" ? "recorded" : "verified"} for ${sourceSHA}\n`
);

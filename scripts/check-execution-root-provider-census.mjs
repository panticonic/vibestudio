import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const census = JSON.parse(
  fs.readFileSync(
    path.join(root, "docs/runtime-foundations/execution-root-provider-census.json"),
    "utf8"
  )
);
const expected = new Set([
  "runtime-entity",
  "panel-history",
  "app-generation",
  "terminal-app",
  "runtime-image",
  "extension-generation",
  "eval-run",
  "development-run",
  "product-seed",
]);
const errors = [];
const declared = new Set(census.providers.map((provider) => provider.id));
for (const id of expected) if (!declared.has(id)) errors.push(`missing provider ${id}`);
function reviewSource(source, owner) {
  if (
    typeof source !== "string" ||
    source.length === 0 ||
    path.isAbsolute(source) ||
    path.normalize(source) !== source ||
    source.split(path.sep).includes("..")
  ) {
    errors.push(`${owner} has invalid reviewed source ${JSON.stringify(source)}`);
    return;
  }
  if (!fs.existsSync(path.join(root, source))) {
    errors.push(`${owner} reviewed source does not exist: ${source}`);
  }
}
for (const provider of census.providers) {
  if (!expected.has(provider.id)) errors.push(`unknown provider ${provider.id}`);
  for (const source of provider.backingSources) {
    reviewSource(source, `provider ${provider.id}`);
  }
  for (const source of provider.reviewedReaders ?? []) {
    reviewSource(source, `provider ${provider.id}`);
  }
}
for (const exemption of census.reviewedExemptions) {
  if (typeof exemption.reason !== "string" || exemption.reason.trim().length === 0) {
    errors.push(`reviewed exemption ${JSON.stringify(exemption.source)} has no reason`);
  }
  reviewSource(exemption.source, "reviewed exemption");
}

const registration = fs.readFileSync(path.join(root, "src/server/index.ts"), "utf8");
for (const id of expected) {
  if (!registration.includes(`id: "${id}"`) && !registration.includes(`"${id}"`)) {
    errors.push(`${id} is not registered by the server composition root`);
  }
}

const covered = new Set([
  ...census.providers.flatMap((provider) => provider.backingSources),
  ...census.providers.flatMap((provider) => provider.reviewedReaders ?? []),
  ...census.reviewedExemptions.map((entry) => entry.source),
]);
const candidates = new Map();
function addCandidate(source, reason) {
  const reasons = candidates.get(source) ?? new Set();
  reasons.add(reason);
  candidates.set(source, reasons);
}
function visit(relative) {
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) {
      visit(child);
      continue;
    }
    if (
      !entry.isFile() ||
      !child.endsWith(".ts") ||
      child.endsWith(".test.ts") ||
      child.includes("/__fixtures__/")
    ) {
      continue;
    }
    const source = fs.readFileSync(path.join(root, child), "utf8");
    if (/\.getBuildByKey(?:\?\.)?\s*\(/u.test(source)) {
      addCandidate(child, "reads getBuildByKey");
    }
    if (/\.activeBundleKey\b/u.test(source)) {
      addCandidate(child, "resolves activeBundleKey");
    }
    if (
      /\bexecutionDigest\b/u.test(source) &&
      /writeFileSync|saveVersionedJsonFile|INSERT INTO|UPDATE\s+\w+[\s\S]{0,120}execution|persist\(/u.test(
        source
      )
    ) {
      addCandidate(child, "persists executionDigest");
    }
  }
}
for (const sourceRoot of ["src", "packages", "workspace"]) visit(sourceRoot);
for (const [candidate, reasons] of candidates) {
  if (!covered.has(candidate)) {
    errors.push(
      `executable build reader/owner lacks provider or reviewed exemption: ${candidate} (${[
        ...reasons,
      ].join(", ")})`
    );
  }
}
if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(`Execution root provider census OK (${expected.size} providers)`);

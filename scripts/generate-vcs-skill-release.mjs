/**
 * Generate and validate the portable contract shipped with the canonical VCS
 * skill. The TypeScript service schema owns request and response shapes; the
 * skill owns procedure. This script only keeps those two surfaces in sync.
 *
 * Usage:
 *   node --import tsx scripts/generate-vcs-skill-release.mjs
 *   node --import tsx scripts/generate-vcs-skill-release.mjs --check
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import {
  vcsErrorSchema,
  vcsMethods,
  vcsOperationRegistry,
  vcsSemanticReferenceInventory,
  vcsStateNodeRefSchema,
} from "../packages/service-schemas/src/vcs.ts";

const scriptPath = fileURLToPath(import.meta.url);
export const repoRoot = path.resolve(path.dirname(scriptPath), "..");

const ROOT = "workspace/skills/vibestudio-vcs";
const SKILL_PATH = `${ROOT}/SKILL.md`;
const CONTRACT_JSON_PATH = `${ROOT}/references/public-contract.json`;
const CONTRACT_MD_PATH = `${ROOT}/references/public-contract.md`;
const MANIFEST_PATH = `${ROOT}/content-manifest.json`;
const FIXTURES_PATH = `${ROOT}/evaluations/schema-fixtures.json`;
const GENERATOR_PATH = "scripts/generate-vcs-skill-release.mjs";
const CONTRACT_SOURCE = "packages/service-schemas/src/vcs.ts";

function absolute(relativePath) {
  return path.join(repoRoot, relativePath);
}

function read(relativePath, overrides = new Map()) {
  return overrides.get(relativePath) ?? fs.readFileSync(absolute(relativePath), "utf8");
}

function stableJson(value, compact = false) {
  return `${JSON.stringify(value, null, compact ? undefined : 2)}\n`;
}

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

function jsonSchema(schema, name) {
  return zodToJsonSchema(schema, {
    name,
    target: "openApi3",
    $refStrategy: "root",
  });
}

export function buildPublicContract() {
  const methodsSchema = z.object(
    Object.fromEntries(
      Object.entries(vcsMethods).map(([name, method]) => [
        name,
        z.object({ arguments: method.args, returns: method.returns ?? z.unknown() }),
      ])
    )
  );
  const exactSchema = z.object({
    stateNode: vcsStateNodeRefSchema,
    typedError: vcsErrorSchema,
    methods: methodsSchema,
  });

  return {
    schemaVersion: 2,
    service: "vcs",
    source: CONTRACT_SOURCE,
    generatedBy: GENERATOR_PATH,
    stateModel: "committed event plus exact event/application working head",
    exactSchema: jsonSchema(exactSchema, "VcsPublicContract"),
    methods: Object.fromEntries(
      Object.entries(vcsMethods).map(([name, method]) => [
        name,
        {
          description: method.description ?? "",
          operationClass: vcsOperationRegistry[name].accessClass,
          access: method.access ?? null,
          errors: method.errors ?? [],
          seeAlso: method.seeAlso ?? [],
          references: vcsSemanticReferenceInventory[name],
        },
      ])
    ),
  };
}

export function renderPublicContractMarkdown(contract) {
  const rows = Object.entries(contract.methods).map(([name, method]) => {
    const errors = method.errors.map(({ code }) => `\`${code}\``).join(", ") || "—";
    return `| \`vcs.${name}\` | \`${method.operationClass}\` | ${method.description.replaceAll("|", "\\|")} | ${errors} |`;
  });
  const errorCodes = [
    ...new Set(
      Object.values(contract.methods).flatMap((method) => method.errors.map(({ code }) => code))
    ),
  ].sort();

  return `<!-- GENERATED FILE — run: pnpm generate:vcs-skill-release -->

# Public VCS contract

This is a portable projection of \`${CONTRACT_SOURCE}\`. The service schema is
the only wire-contract authority; the skill explains how to use it. Exact
request and response JSON Schemas are in
[public-contract.json](public-contract.json).

State is named only by committed events and local work applications. Every
mutation except \`push\` advances an exact context working head; \`commit\` and
\`discard\` consume the complete local application chain.

## Methods

| Method | Class | Purpose | Typed errors |
| --- | --- | --- | --- |
${rows.join("\n")}

## Typed error codes

${errorCodes.map((code) => `- \`${code}\``).join("\n")}

Mutation \`commandId\` values are idempotency identities, not actor or
authorship credentials. Retry the same ID only with an identical request.
Provenance is walked through typed nodes with \`inspect\`, \`neighbors\`,
\`history\`, and \`blame\`.
`;
}

function listSkillFiles() {
  const files = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(absolute(dir), { withFileTypes: true })) {
      const relativePath = `${dir}/${entry.name}`;
      if (entry.isDirectory()) visit(relativePath);
      else if (entry.isFile() && relativePath !== MANIFEST_PATH) files.push(relativePath);
    }
  };
  visit(ROOT);
  return files.sort();
}

export function buildContentManifest(overrides = new Map()) {
  const files = listSkillFiles().map((relativePath) => ({
    path: relativePath.slice(ROOT.length + 1),
    sha256: sha256(read(relativePath, overrides)),
  }));
  return {
    schemaVersion: 2,
    generatedBy: GENERATOR_PATH,
    files,
    packageDigest: sha256(
      files.map(({ path: name, sha256: digest }) => `${name}\0${digest}`).join("\n")
    ),
  };
}

function parseJson(relativePath) {
  return JSON.parse(read(relativePath));
}

export function validateSchemaFixtures() {
  const document = parseJson(FIXTURES_PATH);
  if (document.schemaVersion !== 2 || !Array.isArray(document.fixtures)) {
    throw new Error(`${FIXTURES_PATH}: expected schemaVersion 2 fixtures`);
  }
  const names = new Set();
  let valid = 0;
  let invalid = 0;
  for (const fixture of document.fixtures) {
    if (!fixture.name || names.has(fixture.name)) {
      throw new Error(`${FIXTURES_PATH}: fixture names must be unique`);
    }
    names.add(fixture.name);
    const method = vcsMethods[fixture.method];
    if (!method) throw new Error(`${fixture.name}: unknown method vcs.${fixture.method}`);
    const accepted = method.args.safeParse(fixture.args).success;
    if (accepted !== fixture.valid) {
      throw new Error(
        `${fixture.name}: expected vcs.${fixture.method} validation ${fixture.valid ? "success" : "failure"}`
      );
    }
    fixture.valid ? valid++ : invalid++;
  }
  if (valid < Object.keys(vcsMethods).length || invalid < 3) {
    throw new Error(`${FIXTURES_PATH}: cover every public method and at least three refusals`);
  }
}

function validateCanonicalSkill() {
  const skill = read(SKILL_PATH);
  const roster = Object.keys(vcsMethods);
  if (roster.length !== 18) throw new Error(`public VCS surface grew to ${roster.length} methods`);
  for (const method of roster) {
    if (!skill.includes(method)) throw new Error(`${SKILL_PATH}: does not teach vcs.${method}`);
  }

  const canonicalFiles = listSkillFiles().filter(
    (relativePath) =>
      /\.(?:json|md|yaml|yml)$/u.test(relativePath) &&
      !relativePath.startsWith(`${ROOT}/evaluations/`)
  );
  const deletedSymbols = [
    "vcs.resolveRevision",
    "vcs.planCommit",
    "vcs.walkProvenance",
    "vcs.moveFiles",
    "vcs.copyFiles",
    "expectedTargetFrontierId",
    "sourceBasisId",
    "mergeCertificate",
  ];
  const failures = [];
  for (const relativePath of canonicalFiles) {
    if (relativePath === CONTRACT_JSON_PATH) continue;
    const content = read(relativePath);
    for (const symbol of deletedSymbols) {
      if (content.includes(symbol)) failures.push(`${relativePath}: ${symbol}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`canonical skill still teaches deleted protocol:\n${failures.join("\n")}`);
  }
}

export function buildGeneratedArtifacts() {
  const contract = buildPublicContract();
  const contractJson = stableJson(contract, true);
  const contractMarkdown = renderPublicContractMarkdown(contract);
  const overrides = new Map([
    [CONTRACT_JSON_PATH, contractJson],
    [CONTRACT_MD_PATH, contractMarkdown],
  ]);
  const manifest = buildContentManifest(overrides);
  return new Map([
    [CONTRACT_JSON_PATH, contractJson],
    [CONTRACT_MD_PATH, contractMarkdown],
    [MANIFEST_PATH, stableJson(manifest)],
  ]);
}

export function validateRepositoryReleaseGate() {
  validateCanonicalSkill();
  validateSchemaFixtures();
}

export function runReleaseGate({ checkOnly = false } = {}) {
  const artifacts = buildGeneratedArtifacts();
  const stale = [];
  for (const [relativePath, content] of artifacts) {
    const fullPath = absolute(relativePath);
    const current = fs.existsSync(fullPath) ? fs.readFileSync(fullPath, "utf8") : null;
    if (current === content) continue;
    if (checkOnly) stale.push(relativePath);
    else fs.writeFileSync(fullPath, content);
  }
  if (stale.length > 0) {
    throw new Error(`stale VCS skill artifacts: ${stale.join(", ")}`);
  }
  validateRepositoryReleaseGate();
  console.log(`VCS skill release gate passed (${Object.keys(vcsMethods).length} methods)`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    runReleaseGate({ checkOnly: process.argv.includes("--check") });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

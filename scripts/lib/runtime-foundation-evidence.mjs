import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import ts from "typescript";

const TEST_ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const CENSUS_IDS = new Set(["host-authority", "direct-authority", "bootstrap"]);

export const testEvidence = (testId) => ({ kind: "test", testId });
export const sourceContractEvidence = (contractId) => ({
  kind: "source-contract",
  contractId,
});
export const generatedCensusEvidence = (census) => ({ kind: "generated-census", census });

export function validateRepositoryPath(relativePath, label = "evidence") {
  if (
    typeof relativePath !== "string" ||
    relativePath.length === 0 ||
    relativePath.includes("\\") ||
    path.posix.isAbsolute(relativePath) ||
    path.posix.normalize(relativePath) !== relativePath ||
    relativePath.split("/").includes("..")
  ) {
    throw new Error(`${label} has invalid repository path ${JSON.stringify(relativePath)}`);
  }
}

function repositoryFiles(root) {
  const output = execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: root, encoding: "utf8" }
  );
  return new Set(output.split("\0").filter(Boolean));
}

function exportedNames(source, fileName) {
  const scriptKind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind
  );
  const names = new Set();
  for (const statement of sourceFile.statements) {
    const exported = statement.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword
    );
    if (exported && "name" in statement && statement.name && ts.isIdentifier(statement.name)) {
      names.add(statement.name.text);
    }
    if (ts.isExportDeclaration(statement) && statement.exportClause) {
      if (ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) names.add(element.name.text);
      }
    }
    if (exported && ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
      }
    }
  }
  return names;
}

export function validateEvidenceRegistry({ root, registry }) {
  if (!registry || typeof registry !== "object") {
    throw new Error("runtime-foundation-evidence: registry must be an object");
  }
  const tests = registry.tests ?? {};
  const sourceContracts = registry.sourceContracts ?? {};
  const allIds = new Set();
  const files = repositoryFiles(root);

  for (const [kind, entries] of [
    ["test", tests],
    ["source-contract", sourceContracts],
  ]) {
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
      throw new Error(`runtime-foundation-evidence: ${kind} registry must be an object`);
    }
    for (const [id, entry] of Object.entries(entries)) {
      if (!TEST_ID.test(id)) {
        throw new Error(`runtime-foundation-evidence: invalid ${kind} id ${JSON.stringify(id)}`);
      }
      if (allIds.has(id)) {
        throw new Error(`runtime-foundation-evidence: duplicate evidence id ${JSON.stringify(id)}`);
      }
      allIds.add(id);
      validateRepositoryPath(entry?.path, `runtime-foundation-evidence: ${id}`);
      const absolute = path.join(root, entry.path);
      if (!files.has(entry.path) || !fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
        throw new Error(
          `runtime-foundation-evidence: evidence ${JSON.stringify(id)} points to missing or ignored file ${entry.path}`
        );
      }
      if (kind === "test" && !entry.path.match(/\.(?:test|spec)\.[cm]?[jt]sx?$/)) {
        throw new Error(
          `runtime-foundation-evidence: test ${JSON.stringify(id)} points to non-test file ${entry.path}`
        );
      }
      if (kind === "source-contract") {
        if (typeof entry.exportName !== "string" || !entry.exportName) {
          throw new Error(
            `runtime-foundation-evidence: source contract ${JSON.stringify(id)} has no exportName`
          );
        }
        if (!exportedNames(fs.readFileSync(absolute, "utf8"), entry.path).has(entry.exportName)) {
          throw new Error(
            `runtime-foundation-evidence: source contract ${JSON.stringify(id)} cannot find export ${JSON.stringify(entry.exportName)} in ${entry.path}`
          );
        }
      }
    }
  }
  return { tests, sourceContracts };
}

export function resolveLedgerEvidence({ ledger, subject, evidence, registry, used }) {
  if (!evidence || typeof evidence !== "object") {
    throw new Error(`${ledger}: ${subject} has untyped evidence`);
  }
  if (evidence.kind === "generated-census") {
    if (!CENSUS_IDS.has(evidence.census)) {
      throw new Error(
        `${ledger}: ${subject} references unknown generated census ${JSON.stringify(evidence.census)}`
      );
    }
    return `generated-census:${evidence.census}`;
  }
  const collection =
    evidence.kind === "test"
      ? registry.tests
      : evidence.kind === "source-contract"
        ? registry.sourceContracts
        : null;
  const id = evidence.kind === "test" ? evidence.testId : evidence.contractId;
  if (!collection) {
    throw new Error(
      `${ledger}: ${subject} uses unknown evidence kind ${JSON.stringify(evidence.kind)}`
    );
  }
  if (!collection[id]) {
    throw new Error(`${ledger}: ${subject} references unknown evidence ${JSON.stringify(id)}`);
  }
  used.add(id);
  return `${evidence.kind}:${id}`;
}

export function assertNoOrphanEvidence(registry, used) {
  for (const id of [
    ...Object.keys(registry.tests),
    ...Object.keys(registry.sourceContracts),
  ].sort()) {
    if (!used.has(id)) {
      throw new Error(
        `runtime-foundation-evidence: registry entry ${JSON.stringify(id)} is not used by any ledger row`
      );
    }
  }
}

export function validateEvidenceManifest({ registry, expectedProjects, fragments }) {
  const entries = fragments.flatMap((fragment) => fragment.entries ?? []);
  const errors = [];
  for (const project of expectedProjects) {
    if (!fragments.some((fragment) => fragment.project === project)) {
      errors.push(`test project ${JSON.stringify(project)} did not produce evidence`);
    }
  }
  const byId = new Map();
  for (const entry of entries) {
    const prior = byId.get(entry.id);
    if (prior) {
      errors.push(
        `ledger test ${JSON.stringify(entry.id)} is declared more than once (${prior.file}, ${entry.file})`
      );
      continue;
    }
    byId.set(entry.id, entry);
    const registered = registry.tests[entry.id];
    if (!registered) {
      errors.push(
        `declared ledger test ${JSON.stringify(entry.id)} is absent from the evidence registry`
      );
    } else if (registered.path !== entry.file) {
      errors.push(
        `ledger test ${JSON.stringify(entry.id)} ran from ${entry.file}; registry expects ${registered.path}`
      );
    }
    if (entry.status !== "passed") {
      errors.push(`ledger test ${JSON.stringify(entry.id)} did not pass (status: ${entry.status})`);
    }
  }
  for (const [id, entry] of Object.entries(registry.tests)) {
    if (!byId.has(id)) {
      errors.push(`registry test ${JSON.stringify(id)} was not declared by ${entry.path}`);
    }
  }
  if (errors.length > 0) {
    throw new Error(`Runtime-foundation evidence is invalid:\n- ${errors.join("\n- ")}`);
  }
  return entries.sort((left, right) => left.id.localeCompare(right.id));
}

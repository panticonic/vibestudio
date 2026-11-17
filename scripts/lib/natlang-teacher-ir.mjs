/** Canonical portable Program IR for authored Vibestudio programs and their independently owned fixture worlds. */
import fs from "node:fs";
import path from "node:path";
import { sha256 } from "./natlang-teacher-data.mjs";

const OMIT_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  ".git",
  ".natlang",
  "test-results",
  "eval-results",
  "evaluation-results",
]);
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|nl)$/u;
const TEST_FILE = /(?:\.(?:test|spec)\.[cm]?[jt]sx?$|^suite\.[cm]?[jt]sx?$|\.d\.nl\.ts$)/u;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function relativePath(value, label) {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`${label} must be a normalized workspace-relative path`);
  }
  return value;
}

function finiteJSON(value, label) {
  const text = JSON.stringify(value, (_key, item) => {
    if (
      item === undefined ||
      typeof item === "function" ||
      typeof item === "symbol" ||
      typeof item === "bigint" ||
      (typeof item === "number" && !Number.isFinite(item))
    )
      throw new Error(`${label} must be finite JSON`);
    return item;
  });
  if (text === undefined) throw new Error(`${label} must be finite JSON`);
  return JSON.parse(text);
}

function read(root, relative) {
  relativePath(relative, "source path");
  const absolute = path.join(root, relative);
  const realRoot = fs.realpathSync(root),
    realFile = fs.realpathSync(absolute);
  if (!realFile.startsWith(`${realRoot}${path.sep}`))
    throw new Error(`source escapes its snapshot: ${relative}`);
  return utf8.decode(fs.readFileSync(absolute));
}

function directoryWithin(root, relative) {
  relativePath(relative, "source directory");
  const realRoot = fs.realpathSync(root),
    directory = fs.realpathSync(path.join(root, relative));
  if (!directory.startsWith(`${realRoot}${path.sep}`) || !fs.statSync(directory).isDirectory()) {
    throw new Error(`source directory escapes its snapshot: ${relative}`);
  }
  return directory;
}

function walk(root, visit, directory = "") {
  for (const entry of fs
    .readdirSync(path.join(root, directory), { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))) {
    if (
      entry.name.startsWith(".") ||
      entry.name.startsWith("vendor") ||
      OMIT_DIRECTORIES.has(entry.name)
    )
      continue;
    const relative = directory ? `${directory}/${entry.name}` : entry.name;
    // Authored snapshots never follow a host dependency or an outside symlink.
    if (entry.isDirectory()) walk(root, visit, relative);
    else if (entry.isFile()) visit(relative, entry.name);
  }
}

/** The document world excludes evaluation feedback, not the public Eval API reference. */
export function isFixtureDocument(relative) {
  return (
    relative.endsWith(".md") &&
    path.posix.basename(relative) !== "DECOMPOSITION.md" &&
    !relative
      .split("/")
      .some(
        (part) => part.startsWith(".") || part.startsWith("vendor") || OMIT_DIRECTORIES.has(part)
      )
  );
}

function inputAt(input, parts, name) {
  if (!Array.isArray(parts)) throw new Error(`${name} needs an explicit input path`);
  let value = input;
  for (const part of parts) {
    if (
      (typeof part !== "string" && !Number.isSafeInteger(part)) ||
      value === null ||
      typeof value !== "object" ||
      !Object.hasOwn(value, part)
    ) {
      throw new Error(`case input does not supply ${name} at ${JSON.stringify(parts)}`);
    }
    value = value[part];
  }
  return finiteJSON(value, `input ${name}`);
}

function strings(values, label) {
  if (
    !Array.isArray(values) ||
    !values.length ||
    values.some((value) => typeof value !== "string" || !value.trim())
  ) {
    throw new Error(`${label} must contain nonempty strings`);
  }
  return [...new Set(values)];
}

/**
 * `selection` is one committed natlang-teacher-suites.json entry. Assets and the selected case are captured now;
 * execution subsequently reads only this IR, never a live template checkout or another partition's case file.
 */
export function serializeTeacherIR({ selection, testCase, workspaceRoot, source, sourceCase }) {
  if (!selection?.ir || !selection.template || !selection.suite)
    throw new Error("suite needs explicit canonical IR metadata");
  if (
    !testCase?.id ||
    !testCase.group ||
    !["train", "validation", "test"].includes(testCase.split) ||
    !Object.hasOwn(testCase, "expected")
  ) {
    throw new Error(
      "fixture case needs id, group, split, and its independently supplied expected contract"
    );
  }
  const suiteModule = relativePath(selection.path, "suite path");
  const programRoot = path.posix.dirname(suiteModule);
  relativePath(programRoot, "program root");
  const selector =
    selection.ir.selector === null ? "default" : testCase.input?.[selection.ir.selector];
  const variant = selection.ir.cases?.[selector];
  if (!variant) throw new Error(`no IR entry for ${selection.suite}/${String(selector)}`);
  const root = relativePath(variant.root, "natural-language root");
  const programEntry = relativePath(selection.ir.program_entry, "authored program entry");
  const entryModule = relativePath(variant.entry?.module, "authored entry module");
  if (
    !root.endsWith(".nl") ||
    !["entry", "semantic-anchor"].includes(variant.root_role) ||
    !["natlang-root", "authored-module"].includes(variant.entry?.kind) ||
    typeof variant.entry?.export !== "string" ||
    !variant.entry.export ||
    !Array.isArray(variant.entry.export_path) ||
    !variant.entry.export_path.length ||
    variant.entry.export_path.some(
      (name) => typeof name !== "string" || !/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(name)
    )
  )
    throw new Error("invalid authored IR entry metadata");
  if (
    variant.entry.kind === "natlang-root" &&
    (variant.root_role !== "entry" || entryModule !== root)
  ) {
    throw new Error("a direct natural-language entry must name its actual root");
  }

  const modelFiles = {};
  const absoluteProgram = directoryWithin(workspaceRoot, programRoot);
  walk(absoluteProgram, (relative, name) => {
    if ((SOURCE_FILE.test(name) && !TEST_FILE.test(name)) || name === "package.json")
      modelFiles[relative] = read(absoluteProgram, relative);
  });
  if (
    !Object.hasOwn(modelFiles, root) ||
    !Object.hasOwn(modelFiles, entryModule) ||
    !Object.hasOwn(modelFiles, programEntry)
  )
    throw new Error("IR entry is absent from the authored program source");

  const inputs = Object.create(null),
    inputArguments = [],
    serviceInputs = [];
  for (const argument of variant.arguments ?? []) {
    const name = argument.name;
    if (
      typeof name !== "string" ||
      !/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(name) ||
      inputArguments.includes(name)
    )
      throw new Error("invalid or duplicate authored entry argument");
    inputArguments.push(name);
    if (argument.service === true) {
      if (Object.hasOwn(argument, "path"))
        throw new Error("a service argument cannot carry a JSON value");
      serviceInputs.push(name);
    } else inputs[name] = inputAt(testCase.input, argument.path, name);
  }

  const hostFiles = { [suiteModule]: read(workspaceRoot, suiteModule) };
  // The isolated host suite type-checks its original imports without gaining executable model modules.
  for (const [relative, text] of Object.entries(modelFiles)) {
    if (path.posix.basename(relative) === "types.ts" || relative.endsWith(".d.ts"))
      hostFiles[`${programRoot}/${relative}`] = text;
  }
  for (const asset of variant.assets ?? []) {
    if (asset.kind === "workspace-markdown") {
      walk(workspaceRoot, (relative) => {
        if (isFixtureDocument(relative)) hostFiles[relative] = read(workspaceRoot, relative);
      });
    } else if (asset.kind === "file") {
      const relative = relativePath(asset.path, "fixture asset");
      hostFiles[relative] = read(workspaceRoot, relative);
    } else if (asset.kind === "directory") {
      const relative = relativePath(asset.path, "fixture asset directory");
      walk(directoryWithin(workspaceRoot, relative), (child) => {
        hostFiles[`${relative}/${child}`] = read(workspaceRoot, `${relative}/${child}`);
      });
    } else throw new Error(`unknown fixture asset kind ${asset.kind}`);
  }
  for (const [relative, text] of Object.entries(modelFiles)) {
    const mounted = `${programRoot}/${relative}`;
    if (Object.hasOwn(hostFiles, mounted) && hostFiles[mounted] !== text)
      throw new Error(`fixture overwrites model source: ${mounted}`);
  }
  if (Object.keys(hostFiles).some((file) => /(?:^|\/)cases\.jsonl$/u.test(file)))
    throw new Error("fixture bundle must not contain a protected case inventory");

  const namespace = `vibestudio:${selection.template}:${selection.suite}`;
  const snapshot = finiteJSON(source, "source provenance");
  const revisions =
    sourceCase?.source_revisions ??
    [snapshot.template_commit, snapshot.base_commit].filter(Boolean);
  return {
    version: "natlang.program/2",
    kind: "evaluation_fixture",
    id: `${namespace}:${testCase.id}`,
    split: testCase.split,
    family: namespace,
    source: "vibestudio",
    source_namespace: namespace,
    source_ids: strings(sourceCase?.source_ids ?? [`${namespace}:${testCase.id}`], "source_ids"),
    source_groups: strings(
      sourceCase?.source_groups ?? [`${namespace}:${testCase.group}`],
      "source_groups"
    ),
    source_revisions: strings(revisions, "source_revisions"),
    source_snapshot: snapshot,
    semantics: {
      root,
      files: modelFiles,
      inputs: finiteJSON(inputs, "entry inputs"),
      expected: finiteJSON(testCase.expected, "expected contract"),
      evaluation_fixture: {
        schema: "natlang.evaluation-fixture/1",
        host_files: hostFiles,
        suite_module: suiteModule,
        program_root: programRoot,
        program_entry: programEntry,
        case: finiteJSON(testCase, "fixture case"),
        entry: { ...variant.entry, input_arguments: inputArguments },
        root_role: variant.root_role,
        service_inputs: serviceInputs,
      },
    },
    fixture_sha256: sha256({ files: modelFiles, host_files: hostFiles, case: testCase, variant }),
  };
}

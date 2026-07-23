import type { TestCase, TestExecutionResult } from "../types.js";
import {
  completedScenarioEvidence,
  requireCodeOperations,
  walkArrays,
  walkRecords,
} from "./_scenario-evidence.js";
import { findLastAgentMessage } from "./_helpers.js";

const DIRECT_FS_TOOL_OPERATIONS: Readonly<Record<string, readonly string[]>> = {
  write: ["fs.writeFile"],
  read: ["fs.readFile"],
  ls: ["fs.readdir"],
  move_file: ["fs.rename"],
  copy_file: ["fs.copyFile"],
};

function strings(values: readonly unknown[]): string[] {
  const found: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === "string") found.push(value);
    else if (value && typeof value === "object") {
      for (const child of Object.values(value)) visit(child);
    }
  };
  for (const value of values) visit(value);
  return found;
}

function duplicateNonEmptyString(values: readonly unknown[]): boolean {
  const seen = new Set<string>();
  return strings(values).some((value) => {
    if (!value) return false;
    if (seen.has(value)) return true;
    seen.add(value);
    return false;
  });
}

function duplicateNonEmptyArray(values: readonly unknown[]): boolean {
  const arrays = walkArrays(values).filter((value) => value.length > 0);
  return arrays.some((value, index) =>
    arrays.slice(index + 1).some((candidate) => JSON.stringify(value) === JSON.stringify(candidate))
  );
}

function checkedFs(
  result: TestExecutionResult,
  operations: readonly (readonly string[])[],
  prove: (values: readonly unknown[]) => boolean,
  reason: string
) {
  const base = completedScenarioEvidence(result, []);
  if (!base.passed) return base;
  const directOperations = new Set(
    base.evidence.calls
      .filter(
        (call) => call.execution?.status === "complete" && call.execution.isError !== true
      )
      .flatMap((call) => DIRECT_FS_TOOL_OPERATIONS[call.name] ?? [])
  );
  const exercised = operations.some((alternative) =>
    alternative.every(
      (operation) =>
        directOperations.has(operation) ||
        requireCodeOperations(base.evidence.evalCode, [[operation]]).passed
    )
  )
    ? { passed: true as const, reason: undefined }
    : requireCodeOperations(base.evidence.evalCode, operations);
  if (!exercised.passed) return exercised;
  const values = [
    ...base.evidence.evalValues,
    ...base.evidence.calls
      .filter(
        (call) => call.execution?.status === "complete" && call.execution.isError !== true
      )
      .flatMap((call) => [call.arguments, call.execution?.result]),
    findLastAgentMessage(result),
  ];
  return prove(values)
    ? { passed: true, reason: undefined }
    : { passed: false, reason };
}

export const filesystemTests: TestCase[] = [
  {
    name: "read-write-text",
    description: "Write and read a text file",
    category: "filesystem",
    prompt: "Round-trip some text through a temporary file and tell me what you verified.",
    validate: (result) =>
      checkedFs(
        result,
        [["fs.writeFile", "fs.readFile"]],
        duplicateNonEmptyString,
        "The completed file operations did not return matching written and read text"
      ),
  },
  {
    name: "read-write-binary",
    description: "Write binary data and decode it back",
    category: "filesystem",
    prompt: "Round-trip a small binary payload through a temporary file and explain what survived.",
    validate: (result) =>
      checkedFs(
        result,
        [["fs.writeFile", "fs.readFile"]],
        (values) => duplicateNonEmptyString(values) || duplicateNonEmptyArray(values),
        "The completed file operations did not expose a matching binary payload"
      ),
  },
  {
    name: "append-file",
    description: "Append content to a file and verify all content is present",
    category: "filesystem",
    prompt: "Verify that appending to a temporary file preserves both pieces of content.",
    validate: (result) =>
      checkedFs(
        result,
        [["fs.writeFile", "fs.appendFile", "fs.readFile"]],
        (values) =>
          strings(values).some((value) => value.split(/\r?\n/u).filter(Boolean).length >= 2),
        "The completed append probe did not return both pieces of content"
      ),
  },
  {
    name: "directory-ops",
    description: "Create nested directories and list contents",
    category: "filesystem",
    prompt: "Create a temporary nested directory with two files, inspect it, and clean it up.",
    validate: (result) =>
      checkedFs(
        result,
        [["fs.mkdir", "fs.readdir", "fs.rm"]],
        (values) =>
          walkArrays(values).some(
            (value) => value.length === 2 && value.every((entry) => typeof entry === "string")
          ),
        "The completed directory listing did not contain exactly two entries"
      ),
  },
  {
    name: "file-stats",
    description: "Get file statistics including size and modification time",
    category: "filesystem",
    prompt:
      "Inspect the metadata of a temporary file and verify it agrees with the file you wrote.",
    validate: (result) =>
      checkedFs(
        result,
        [["fs.writeFile", "fs.stat"]],
        (values) =>
          walkRecords(values).some(
            (record) =>
              typeof record["size"] === "number" &&
              record["size"] > 0 &&
              (record["mtime"] !== undefined || record["mtimeMs"] !== undefined)
          ),
        "The completed stat probe did not expose a positive size and modification time"
      ),
  },
  {
    name: "rename-copy",
    description: "Copy or rename a file and verify the result",
    category: "filesystem",
    prompt:
      "Copy or relocate a temporary file, verify its content at the destination, and clean up.",
    validate: (result) =>
      checkedFs(
        result,
        [
          ["fs.rename", "fs.readFile"],
          ["fs.copyFile", "fs.readFile"],
        ],
        duplicateNonEmptyString,
        "The completed transfer probe did not return matching source and destination content"
      ),
  },
  {
    name: "remove",
    description: "Create and recursively remove a directory",
    category: "filesystem",
    prompt: "Create a temporary directory tree, remove it, and verify that it is gone.",
    validate: (result) =>
      checkedFs(
        result,
        [["fs.mkdir", "fs.rm"]],
        (values) =>
          walkRecords(values).some(
            (record) =>
              record["absent"] === true ||
              record["exists"] === false ||
              record["removed"] === true ||
              record["cleaned"] === true ||
              Object.entries(record).some(
                ([key, value]) => /exists.*after|after.*exists/iu.test(key) && value === false
              )
          ) ||
          strings(values).some(
            (value) =>
              /(?:exists[^\n]{0,40}after|after[^\n]{0,40}exists)[^a-z0-9]{0,8}false/iu.test(
                value
              ) || /(?:gone|absent)[^a-z0-9]{0,8}true/iu.test(value)
          ),
        "The completed removal probe did not prove the directory is absent"
      ),
  },
  {
    name: "symlinks",
    description: "Probe symbolic-link inspection and creation support",
    category: "filesystem",
    prompt:
      "Check how temporary symbolic links behave here and report the observed support honestly.",
    validate: (result) =>
      checkedFs(
        result,
        [
          ["fs.symlink", "fs.lstat"],
          ["fs.symlink", "fs.readlink"],
        ],
        (values) =>
          walkRecords(values).some(
            (record) =>
              record["supported"] === true ||
              record["symlinkCreated"] === true ||
              record["isSym"] === true ||
              (record["supported"] === false && typeof record["reason"] === "string")
          ) ||
          strings(values).some(
            (value) =>
              /(?:symbolic links?|symlinks?)[^\n]{0,50}\bsupported\b/iu.test(value) ||
              /(?:isSym|isSymbolicLink|symlinkCreated)[^a-z0-9]{0,12}true/iu.test(value)
          ),
        "The completed symlink probe exposed neither verified support nor a concrete limitation"
      ),
  },
  {
    name: "file-handles",
    description: "Use low-level file handles to write and read",
    category: "filesystem",
    prompt: "Check the temporary low-level file-handle lifecycle and report what you could verify.",
    validate: (result) =>
      checkedFs(
        result,
        [["fs.open", ".close"]],
        duplicateNonEmptyString,
        "The completed handle lifecycle did not prove a read/write round trip or a supported limitation"
      ),
  },
];

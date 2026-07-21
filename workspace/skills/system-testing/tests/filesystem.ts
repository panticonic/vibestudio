import type { TestCase, TestExecutionResult } from "../types.js";
import {
  completedScenarioEvidence,
  requireCodeOperations,
  walkArrays,
  walkRecords,
} from "./_scenario-evidence.js";

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
  const base = completedScenarioEvidence(result);
  if (!base.passed) return base;
  const exercised = requireCodeOperations(base.evidence.evalCode, operations);
  if (!exercised.passed) return exercised;
  return prove(base.evidence.evalValues)
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
        [["fs.writeFile", "fs.readFile", "fs.rm"]],
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
        [["fs.writeFile", "fs.readFile", "fs.rm"]],
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
        [["fs.writeFile", "fs.appendFile", "fs.readFile", "fs.rm"]],
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
        [["fs.writeFile", "fs.stat", "fs.rm"]],
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
          ["fs.rename", "fs.readFile", "fs.rm"],
          ["fs.copyFile", "fs.readFile", "fs.rm"],
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
            (record) => record["absent"] === true || record["exists"] === false
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
              typeof record["supported"] === "boolean" &&
              (record["supported"] === true || typeof record["reason"] === "string")
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
        [["fs.open", ".close", "fs.rm"]],
        duplicateNonEmptyString,
        "The completed handle lifecycle did not prove a read/write round trip or a supported limitation"
      ),
  },
];

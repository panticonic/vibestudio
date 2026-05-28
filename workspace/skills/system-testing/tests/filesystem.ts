import type { TestCase } from "../types.js";
import { finalMessageHasAll, finalMessageHasAny } from "./_helpers.js";

function checked(result: Parameters<typeof finalMessageHasAll>[0], tokens: string[]) {
  return finalMessageHasAll(result, tokens);
}

export const filesystemTests: TestCase[] = [
  {
    name: "read-write-text",
    description: "Write and read a text file",
    category: "filesystem",
    prompt: "Exercise text file round-trip. Finish with FS_TEXT_OK.",
    validate: (result) => checked(result, ["FS_TEXT_OK"]),
  },
  {
    name: "read-write-binary",
    description: "Write binary data and decode it back",
    category: "filesystem",
    prompt: "Exercise binary file round-trip. Finish with FS_BINARY_OK.",
    validate: (result) => checked(result, ["FS_BINARY_OK"]),
  },
  {
    name: "append-file",
    description: "Append content to a file and verify all content is present",
    category: "filesystem",
    prompt: "Exercise file append behavior. Finish with FS_APPEND_OK and line-count:2.",
    validate: (result) => checked(result, ["FS_APPEND_OK", "line-count:2"]),
  },
  {
    name: "directory-ops",
    description: "Create nested directories and list contents",
    category: "filesystem",
    prompt: "Exercise nested directory creation and listing. Finish with FS_DIR_OK and files:2.",
    validate: (result) => checked(result, ["FS_DIR_OK", "files:2"]),
  },
  {
    name: "file-stats",
    description: "Get file statistics including size and modification time",
    category: "filesystem",
    prompt: "Exercise file stats. Finish with FS_STATS_OK and size-match.",
    validate: (result) => checked(result, ["FS_STATS_OK", "size-match"]),
  },
  {
    name: "rename-copy",
    description: "Copy or rename a file and verify the result",
    category: "filesystem",
    prompt: "Exercise file copy or rename. Finish with FS_COPY_RENAME_OK and content-match.",
    validate: (result) => checked(result, ["FS_COPY_RENAME_OK", "content-match"]),
  },
  {
    name: "remove",
    description: "Create and recursively remove a directory",
    category: "filesystem",
    prompt: "Exercise recursive removal. Finish with FS_REMOVE_OK and gone.",
    validate: (result) => checked(result, ["FS_REMOVE_OK", "gone"]),
  },
  {
    name: "symlinks",
    description: "Create and read through a symbolic link",
    category: "filesystem",
    prompt: "Exercise symlink behavior. Finish with FS_SYMLINK_OK or FS_SYMLINK_UNSUPPORTED.",
    validate: (result) => finalMessageHasAny(result, ["FS_SYMLINK_OK", "FS_SYMLINK_UNSUPPORTED"]),
  },
  {
    name: "file-handles",
    description: "Use low-level file handles to write and read",
    category: "filesystem",
    prompt: "Exercise file-handle behavior. Finish with FS_HANDLE_OK or FS_HANDLE_UNAVAILABLE.",
    validate: (result) => finalMessageHasAny(result, ["FS_HANDLE_OK", "FS_HANDLE_UNAVAILABLE"]),
  },
];

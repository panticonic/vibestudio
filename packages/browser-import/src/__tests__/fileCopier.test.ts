import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { copyDatabaseToTemp, copyFileToTemp, releaseTempDatabase } from "../import/fileCopier.js";
let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "browser-copy-lifecycle-"));
  vi.stubEnv("VIBESTUDIO_PROFILE_ROOT", path.join(root, "profile"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});
it("retires exact database/WAL/SHM copies and leaves originals and neighboring files intact", async () => {
  const source = path.join(root, "History.db");
  for (const suffix of ["", "-wal", "-shm"]) fs.writeFileSync(source + suffix, "original" + suffix);
  const copy = await copyDatabaseToTemp(source);
  expect(fs.readFileSync(copy.path + "-wal", "utf8")).toBe("original-wal");
  await copy.release();
  await copy.release();
  expect(fs.existsSync(path.dirname(copy.path))).toBe(false);
  for (const suffix of ["", "-wal", "-shm"])
    expect(fs.readFileSync(source + suffix, "utf8")).toBe("original" + suffix);
});
it("retires a copy even when closing its reader fails", async () => {
  const source = path.join(root, "Bookmarks");
  fs.writeFileSync(source, "original");
  const copy = await copyFileToTemp(source);
  const failure = new Error("SQLite close failed");
  await expect(
    releaseTempDatabase(
      {
        close() {
          throw failure;
        },
      },
      copy
    )
  ).rejects.toThrow();
  expect(fs.existsSync(copy.path)).toBe(false);
  expect(fs.readFileSync(source, "utf8")).toBe("original");
});

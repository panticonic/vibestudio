import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeFileAtomicSync, type AtomicWriteFs } from "./atomicFile.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function target(): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-atomic-write-"));
  roots.push(dir);
  return { dir, file: path.join(dir, "nested", "credential.json") };
}

describe("writeFileAtomicSync", () => {
  it("durably replaces a file and enforces private permissions", () => {
    const { file } = target();

    writeFileAtomicSync(file, "first");
    writeFileAtomicSync(file, "second");

    expect(fs.readFileSync(file, "utf8")).toBe("second");
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("preserves the previous good file and removes the temp file when replacement fails", () => {
    const { dir, file } = target();
    writeFileAtomicSync(file, "good");
    const failingFs: AtomicWriteFs = {
      ...fs,
      renameSync: () => {
        throw new Error("simulated rename failure");
      },
    };

    expect(() => writeFileAtomicSync(file, "partial", { fs: failingFs })).toThrow(
      /simulated rename failure/
    );

    expect(fs.readFileSync(file, "utf8")).toBe("good");
    expect(
      fs.readdirSync(path.join(dir, "nested")).filter((entry) => entry.endsWith(".tmp"))
    ).toEqual([]);
  });
});

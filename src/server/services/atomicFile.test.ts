import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { describe, expect, it } from "vitest";
import { writeJsonFileAtomic } from "./atomicFile.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vibez1-atomic-file-"));
}

describe("writeJsonFileAtomic", () => {
  it("writes and replaces JSON files without leaving temp files behind", () => {
    const dir = tempDir();
    const filePath = path.join(dir, "grants.json");

    writeJsonFileAtomic(filePath, { grants: [{ choice: "allow" }] });
    writeJsonFileAtomic(filePath, { grants: [{ choice: "deny" }] });

    expect(JSON.parse(fs.readFileSync(filePath, "utf8"))).toEqual({
      grants: [{ choice: "deny" }],
    });
    expect(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FirefoxReader } from "../readers/firefoxReader.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("FirefoxReader", () => {
  it("treats category databases absent from a registered profile as empty", async () => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-firefox-profile-"));
    roots.push(profile);
    const reader = new FirefoxReader();

    await expect(reader.readBookmarks(profile)).resolves.toEqual([]);
    await expect(reader.readHistory(profile)).resolves.toEqual([]);
    await expect(reader.readCookies(profile)).resolves.toEqual([]);
  });
});

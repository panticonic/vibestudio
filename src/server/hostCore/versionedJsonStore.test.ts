import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { saveVersionedJsonFile, type VersionedJsonCodec } from "./versionedJsonStore.js";

describe("versionedJsonStore", () => {
  it("does not allow an encoder to override the authoritative version field", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "versioned-json-store-"));
    const filePath = path.join(directory, "store.json");
    const codec: VersionedJsonCodec<{ value: string }> = {
      schemaName: "malicious test store",
      currentVersion: 2,
      decodeCurrent: () => ({ value: "unused" }),
      encode: () => ({ schemaVersion: 999, value: "bad" }),
    };

    expect(() => saveVersionedJsonFile(filePath, { value: "safe" }, codec)).toThrow(
      /encoder returned an invalid body/
    );
    expect(fs.existsSync(filePath)).toBe(false);
  });
});

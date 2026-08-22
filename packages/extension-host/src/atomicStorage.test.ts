import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { replaceExtensionStorageFile } from "./atomicStorage.js";

describe("replaceExtensionStorageFile", () => {
  let root = "";

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "extension-atomic-storage-"));
    await fs.mkdir(path.join(root, "records"));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it("atomically replaces a regular file with synced private bytes", async () => {
    const target = path.join(root, "records", "state.json");
    await fs.writeFile(target, "old", { mode: 0o644 });

    await replaceExtensionStorageFile(root, "records/state.json", "new");

    expect(await fs.readFile(target, "utf8")).toBe("new");
    expect((await fs.stat(target)).mode & 0o777).toBe(0o600);
    expect(await fs.readdir(path.dirname(target))).toEqual(["state.json"]);
  });

  it("preserves the prior file and removes its owned temporary after a pre-rename failure", async () => {
    const target = path.join(root, "records", "state.json");
    await fs.writeFile(target, "old");

    await expect(
      replaceExtensionStorageFile(root, "records/state.json", "new", {
        beforeRename: () => {
          throw Object.assign(new Error("simulated crash boundary"), { code: "EIO" });
        },
      })
    ).rejects.toMatchObject({ code: "EIO" });

    expect(await fs.readFile(target, "utf8")).toBe("old");
    expect(await fs.readdir(path.dirname(target))).toEqual(["state.json"]);
  });

  it("rejects a symlink destination without changing its referent", async () => {
    const outside = path.join(root, "outside.json");
    await fs.writeFile(outside, "outside");
    await fs.symlink(outside, path.join(root, "records", "state.json"));

    await expect(
      replaceExtensionStorageFile(root, "records/state.json", "replacement")
    ).rejects.toMatchObject({ code: "EINVAL" });
    expect(await fs.readFile(outside, "utf8")).toBe("outside");
  });

  it("rejects non-file destinations and symlinked parent drift", async () => {
    await fs.mkdir(path.join(root, "records", "directory.json"));
    await expect(
      replaceExtensionStorageFile(root, "records/directory.json", "replacement")
    ).rejects.toMatchObject({ code: "EINVAL" });

    await fs.mkdir(path.join(root, "real"));
    await fs.symlink(path.join(root, "real"), path.join(root, "linked"));
    await expect(replaceExtensionStorageFile(root, "linked/state.json", "replacement")).rejects.toMatchObject({
      code: "EACCES",
    });
  });

  it("rejects paths outside the private storage root", async () => {
    await expect(replaceExtensionStorageFile(root, "../escape.json", "nope")).rejects.toMatchObject({
      code: "EACCES",
    });
  });
});

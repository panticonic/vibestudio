import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sha256Hex } from "@vibestudio/content-addressing";
import { blobCasPath } from "./storage/blobCas.js";
import {
  installPreparedWorkspaceTemplate,
  type PreparedWorkspaceTemplate,
} from "./preparedWorkspaceTemplate.js";

const pin = {
  url: "git+https://github.com/example/template.git",
  commit: "a".repeat(40),
  ref: "refs/heads/main",
};
const bytes = Buffer.from("export default {};");
const digest = sha256Hex(bytes);
const record: PreparedWorkspaceTemplate = {
  format: "vibestudio-prepared-workspace/1",
  purpose: "use",
  pin,
  layers: [pin],
  installation: { sources: [{ pin, manifest: "template: {}" }] },
  snapshot: `v1-sha256:${"b".repeat(64)}`,
  stateHash: `state:${"c".repeat(64)}`,
  files: [
    { path: "workers/source/index.ts", contentHash: digest, size: bytes.length, mode: 0o644 },
  ],
  repositories: [],
  builds: [],
  blobs: [{ digest, size: bytes.length }],
};
let root: string;
let release: string;
let destination: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "prepared-workspace-test-"));
  release = path.join(root, "release");
  destination = path.join(root, "consumer");
  const source = blobCasPath(path.join(release, "blobs"), digest);
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, bytes);
  fs.writeFileSync(path.join(release, "template.json"), JSON.stringify(record));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe("prepared workspace installation", () => {
  it("installs the published immutable closure by reference", async () => {
    expect(await installPreparedWorkspaceTemplate(release, destination, pin, "use")).toEqual(
      record
    );
    const installed = blobCasPath(destination, digest);
    expect(fs.readFileSync(installed)).toEqual(bytes);
    expect(fs.statSync(installed).ino).toBe(
      fs.statSync(blobCasPath(path.join(release, "blobs"), digest)).ino
    );
  });
  it("rejects a different template coordinate before writing consumer state", async () => {
    await expect(
      installPreparedWorkspaceTemplate(
        release,
        destination,
        { ...pin, commit: "d".repeat(40) },
        "use"
      )
    ).rejects.toThrow("creation coordinate");
    expect(fs.existsSync(destination)).toBe(false);
  });
  it("propagates missing release bytes", async () => {
    fs.unlinkSync(blobCasPath(path.join(release, "blobs"), digest));
    await expect(
      installPreparedWorkspaceTemplate(release, destination, pin, "use")
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("rejects truncation before publishing the consumer CAS entry", async () => {
    fs.writeFileSync(blobCasPath(path.join(release, "blobs"), digest), "");
    await expect(
      installPreparedWorkspaceTemplate(release, destination, pin, "use")
    ).rejects.toThrow("size mismatch");
    expect(fs.existsSync(blobCasPath(destination, digest))).toBe(false);
  });
});

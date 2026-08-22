import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createRemoteServeArgs,
  waitForRootInvite,
} from "../scripts/cli/lib/smoke-remote-server.mjs";

const tempDirs: string[] = [];

async function readyFile(payload: unknown): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vibestudio-root-invite-"));
  tempDirs.push(dir);
  const file = path.join(dir, "ready.json");
  await fs.writeFile(file, JSON.stringify(payload));
  return file;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("smoke remote-server root invite selection", () => {
  it("runs an isolated named workspace that survives an intentional server restart", () => {
    const args = createRemoteServeArgs("/repo", "/tmp/ready.json", 43100);
    expect(args).toContain("--bootstrap-workspace");
    expect(args).toContain("mobile-smoke");
    expect(args).not.toContain("--dev");
    expect(args).toContain("/repo/scripts/cli/remote-serve.mjs");
  });

  it("selects the one universal invite from the ready-file contract", async () => {
    const ready = {
      rootInvite: { pairUrl: "https://vibestudio.app/p#root" },
    };

    const file = await readyFile(ready);
    await expect(waitForRootInvite({ readyFile: file })).resolves.toEqual(ready.rootInvite);
  });

  it("fails when the root account already exists", async () => {
    const file = await readyFile({ rootInvite: null });
    await expect(waitForRootInvite({ readyFile: file })).rejects.toThrow(
      "root account already exists"
    );
  });

  it("waits through atomic ready-file replacement gaps", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vibestudio-root-invite-"));
    tempDirs.push(dir);
    const file = path.join(dir, "ready.json");
    const pending = waitForRootInvite({ readyFile: file, timeoutMs: 2_000 });
    await fs.writeFile(
      file,
      JSON.stringify({ rootInvite: { pairUrl: "https://vibestudio.app/p#ready" } })
    );
    await expect(pending).resolves.toEqual({ pairUrl: "https://vibestudio.app/p#ready" });
  });

  it("rejects a malformed ready-file contract immediately", async () => {
    const file = await readyFile({ rootInvite: { pairUrl: "" } });
    await expect(waitForRootInvite({ readyFile: file })).rejects.toThrow("has no pairing URL");
  });
});

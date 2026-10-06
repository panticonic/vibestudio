import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

import {
  createRemoteServeArgs,
  createRemoteSmokeServerEnvironment,
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
  it("isolates the account profile and retains it across a private server restart", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vibestudio-smoke-profile-"));
    tempDirs.push(root);
    const profile = path.join(root, "profile");
    const instance = path.join(root, "instance");
    const env = createRemoteSmokeServerEnvironment(
      { ...process.env, XDG_CONFIG_HOME: profile, VIBESTUDIO_WORKSPACE: "unrelated-workspace" },
      instance,
      path.join(root, "derived")
    );
    const observe = (write: boolean) =>
      JSON.parse(
        execFileSync(
          process.execPath,
          [
            "--import",
            "tsx",
            "--input-type=module",
            "-e",
            `
        import fs from 'node:fs';
        import path from 'node:path';
        import { getCentralDataPath, getProfileDataPath } from '@vibestudio/env-paths';
        const instance = getCentralDataPath();
        const profile = getProfileDataPath();
        fs.mkdirSync(profile, { recursive: true });
        if (${write}) {
          fs.writeFileSync(path.join(instance, 'retained-device.txt'), 'original device');
          fs.writeFileSync(path.join(profile, 'test-provider-config.txt'), 'isolated provider');
        }
        console.log(JSON.stringify({ profile, instance,
          retainedProvider: fs.readFileSync(path.join(profile, 'test-provider-config.txt'), 'utf8'),
          retainedDevice: fs.readFileSync(path.join(instance, 'retained-device.txt'), 'utf8'),
          inheritedWorkspace: process.env.VIBESTUDIO_WORKSPACE ?? null }));
      `,
          ],
          { env, encoding: "utf8" }
        )
      );
    const first = observe(true);
    expect(path.relative(instance, first.profile)).not.toMatch(/^\.\.(?:[\\/]|$)/);
    expect(first.profile).not.toBe(instance);
    expect(first.profile).not.toBe(path.join(profile, "vibestudio"));
    expect(first).toMatchObject({
      instance,
      retainedDevice: "original device",
      retainedProvider: "isolated provider",
      inheritedWorkspace: null,
    });
    expect(observe(false)).toEqual(first);
  });

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

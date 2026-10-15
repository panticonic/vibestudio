import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const run = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe.skipIf(process.platform !== "linux")("native public CLI launcher", () => {
  async function installed() {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "installed-native-launcher-"));
    roots.push(root);
    await fs.mkdir(path.join(root, "resources"));
    const launcher = path.join(root, "resources", "vibestudio-cli");
    await fs.copyFile(path.resolve("build-resources/linux/vibestudio-cli"), launcher);
    await fs.chmod(launcher, 0o755);
    // A stand-in executable records argv and environment without spawning a GUI.
    await fs.writeFile(
      path.join(root, "vibestudio"),
      '#!/bin/sh\nprintf "%s\\n" "$ELECTRON_RUN_AS_NODE" "$VIBESTUDIO_APP_ROOT" "$VIBESTUDIO_HOST_ARTIFACT_ROOT" "$@"\n',
      { mode: 0o755 }
    );
    const command = path.join(root, "vibestudio-command");
    await fs.symlink(launcher, command);
    return { root, command };
  }

  it("dispatches the public symlink terminal command to the exact installed CLI", async () => {
    const { root, command } = await installed();
    const { stdout } = await run(command, ["terminal", "--yes"], { env: {} });
    expect(stdout.split("\n")).toEqual([
      "1",
      path.join(root, "resources/app.asar"),
      path.join(root, "resources/app.asar.unpacked/dist"),
      path.join(root, "resources/app.asar.unpacked/dist/cli/client.mjs"),
      "terminal",
      "--yes",
      "",
    ]);
  });

  it("preserves ordinary desktop and deep-link launches", async () => {
    const { command } = await installed();
    expect((await run(command, [], { env: {} })).stdout).toBe("\n\n\n");
    expect((await run(command, ["vibestudio://connect/test"], { env: {} })).stdout).toBe(
      "\n\n\nvibestudio://connect/test\n"
    );
  });
});

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createLocalClaudeCodeDevelopmentDriver } from "./localClaudeCodeDevelopmentDriver.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function createClaudeFixture(version = "2.1.81") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "vibestudio-native-claude-"));
  roots.push(root);
  const cliPath = path.join(root, "claude");
  const source = `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv.includes("--version")) {
  process.stdout.write(${JSON.stringify(version)} + "\\n");
  process.exit(0);
}
fs.writeFileSync("native-env.json", JSON.stringify(process.env));
process.stdout.write("native-development-ready\\n");
process.stdin.on("data", (data) => process.stdout.write("input:" + data));
process.on("SIGTERM", () => process.exit(0));
setInterval(() => {}, 1000);
`;
  await fs.writeFile(cliPath, source, { mode: 0o755 });
  await fs.chmod(cliPath, 0o755);
  const repositoryRoot = path.join(root, "repository");
  const homeRoot = path.join(root, "home");
  const hostConfig = path.join(root, "host-claude");
  await Promise.all([fs.mkdir(repositoryRoot), fs.mkdir(homeRoot), fs.mkdir(hostConfig)]);
  await fs.writeFile(path.join(hostConfig, ".credentials.json"), '{"oauth":"test-only"}\n', {
    mode: 0o600,
  });
  return { root, cliPath, repositoryRoot, homeRoot, hostConfig };
}

async function waitForFile(filePath: string): Promise<string> {
  const deadline = Date.now() + 5_000;
  do {
    try {
      return await fs.readFile(filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  throw new Error(`Timed out waiting for ${filePath}`);
}

describe("createLocalClaudeCodeDevelopmentDriver", () => {
  it.skipIf(process.platform !== "linux")(
    "launches an exact stripped-environment process group and freezes/resumes/retire it",
    async () => {
      const fixture = await createClaudeFixture();
      process.env["VIBESTUDIO_NATIVE_DRIVER_SECRET_TEST"] = "must-not-cross";
      try {
        const driver = await createLocalClaudeCodeDevelopmentDriver({
          executorId: "executor:local",
          candidatePaths: [fixture.cliPath],
          hostClaudeConfigDirectory: fixture.hostConfig,
        });
        await expect(driver.availability()).resolves.toEqual({ available: true });
        const handle = await driver.launch({
          sessionId: "session-1",
          ownedRootId: "owned-root-1",
          repositoryRoot: fixture.repositoryRoot,
          homeRoot: fixture.homeRoot,
        });
        const environment = JSON.parse(
          await waitForFile(path.join(fixture.repositoryRoot, "native-env.json"))
        ) as Record<string, string>;
        expect(environment["VIBESTUDIO_NATIVE_DRIVER_SECRET_TEST"]).toBeUndefined();
        expect(environment).toMatchObject({
          HOME: fixture.homeRoot,
          USERPROFILE: fixture.homeRoot,
          CLAUDE_CONFIG_DIR: path.join(fixture.homeRoot, ".claude"),
        });
        await expect(
          fs.readFile(path.join(fixture.homeRoot, ".claude", ".credentials.json"), "utf8")
        ).resolves.toBe('{"oauth":"test-only"}\n');
        expect(handle.identity).toMatchObject({
          ownershipToken: expect.stringMatching(/^[0-9a-f]{64}$/u),
          processId: expect.stringMatching(/^linux-pgid:\d+:start:\d+$/u),
        });
        const pid = Number(handle.identity.processId.split(":")[1]);
        const commandLine = (await fs.readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0");
        expect(commandLine[0]).toBe(path.join(fixture.homeRoot, ".vibestudio-toolchain", "node"));
        expect(commandLine[1]).toBe(
          path.join(fixture.homeRoot, ".vibestudio-toolchain", "claude-code")
        );
        const terminalSessionId = handle.identity.terminalSessionId!;
        driver.terminalSurface!.write({
          terminalSessionId,
          writeId: "write-1",
          data: "hello\\n",
        });
        expect(() =>
          driver.terminalSurface!.write({
            terminalSessionId,
            writeId: "write-1",
            data: "hello\\n",
          })
        ).not.toThrow();
        expect(() =>
          driver.terminalSurface!.write({
            terminalSessionId,
            writeId: "write-1",
            data: "different\\n",
          })
        ).toThrow("writeId was reused");
        await new Promise((resolve) => setTimeout(resolve, 25));
        expect(driver.terminalSurface!.read({ terminalSessionId }).text).toContain(
          "native-development-ready"
        );
        expect(driver.terminalSurface!.read({ terminalSessionId }).text).toContain("hello");

        await handle.freezeForCheckpoint();
        await handle.resumeCheckpoint();
        await handle.stop();
        await expect(handle.stop()).resolves.toBeUndefined();
        expect(driver.terminalSurface!.read({ terminalSessionId }).alive).toBe(false);
        await handle.retire();
        expect(() => driver.terminalSurface!.read({ terminalSessionId })).toThrow(
          "Unknown development terminal"
        );
      } finally {
        delete process.env["VIBESTUDIO_NATIVE_DRIVER_SECRET_TEST"];
      }
    }
  );

  it.skipIf(process.platform !== "linux")(
    "fails availability when the sealed CLI bytes change",
    async () => {
      const fixture = await createClaudeFixture();
      const driver = await createLocalClaudeCodeDevelopmentDriver({
        executorId: "executor:local",
        candidatePaths: [fixture.cliPath],
        hostClaudeConfigDirectory: fixture.hostConfig,
      });
      await expect(driver.availability()).resolves.toEqual({ available: true });
      await fs.appendFile(fixture.cliPath, "\n// changed\n");
      await expect(driver.availability()).resolves.toEqual({
        available: false,
        reason: "not-installed",
      });
    }
  );

  it.skipIf(process.platform !== "linux")(
    "returns typed unavailable for an unsupported Claude Code version before launch",
    async () => {
      const fixture = await createClaudeFixture("1.0.0");
      const driver = await createLocalClaudeCodeDevelopmentDriver({
        executorId: "executor:local",
        candidatePaths: [fixture.cliPath],
      });
      await expect(driver.availability()).resolves.toEqual({
        available: false,
        reason: "version-unsupported",
      });
      await expect(
        driver.launch({
          sessionId: "session-1",
          ownedRootId: "owned-root-1",
          repositoryRoot: fixture.repositoryRoot,
          homeRoot: fixture.homeRoot,
        })
      ).rejects.toMatchObject({
        code: "EEXECUTOR_UNAVAILABLE",
        reason: "version-unsupported",
      });
    }
  );
});

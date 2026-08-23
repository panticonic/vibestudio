import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { WORKSPACE_SYSTEM_EPOCH } from "@vibestudio/shared/vcs/systemEpoch";

import { resolveDevelopmentBaseSelection } from "./developmentBaseSelection.js";

const roots: string[] = [];

function git(directory: string, ...args: string[]): void {
  execFileSync("git", ["-C", directory, ...args], {
    stdio: "ignore",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Vibestudio Test",
      GIT_AUTHOR_EMAIL: "test@vibestudio.invalid",
      GIT_COMMITTER_NAME: "Vibestudio Test",
      GIT_COMMITTER_EMAIL: "test@vibestudio.invalid",
    },
  });
}

function fixture(systemEpoch: number): { host: string; base: string; checkpoint: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-base-selection-"));
  roots.push(root);
  const host = path.join(root, "host");
  const base = path.join(root, "base");
  const checkpoint = path.join(root, "checkpoint");
  fs.mkdirSync(path.join(host, "build-resources"), { recursive: true });
  fs.writeFileSync(
    path.join(host, "build-resources", "base-template-release.json"),
    JSON.stringify({
      format: "vibestudio-base-release/1",
      baseTemplate: {
        url: "git+https://example.test/vibestudio-workspace-base.git",
        ref: "refs/tags/v1",
        commit: "a".repeat(40),
        snapshot: `v1-sha256:${"b".repeat(64)}`,
      },
    })
  );
  fs.mkdirSync(path.join(base, "meta"), { recursive: true });
  fs.writeFileSync(path.join(base, "meta", "vibestudio.yml"), `systemEpoch: ${systemEpoch}\n`);
  git(base, "init", "-b", "main");
  git(base, "add", ".");
  git(base, "commit", "-m", "fixture");
  return { host, base, checkpoint };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("resolveDevelopmentBaseSelection", () => {
  it("accepts a development Base at the host runtime epoch", async () => {
    const { host, base, checkpoint } = fixture(WORKSPACE_SYSTEM_EPOCH);

    await expect(
      resolveDevelopmentBaseSelection({
        repoRoot: host,
        checkpointTarget: checkpoint,
        explicitCheckout: base,
      })
    ).resolves.toMatchObject({ sourceCheckout: base, temporary: false });
  });

  it("rejects an incompatible Base before creating a workspace runtime", async () => {
    const { host, base, checkpoint } = fixture(WORKSPACE_SYSTEM_EPOCH - 1);

    await expect(
      resolveDevelopmentBaseSelection({
        repoRoot: host,
        checkpointTarget: checkpoint,
        explicitCheckout: base,
      })
    ).rejects.toThrow(
      `declares systemEpoch ${WORKSPACE_SYSTEM_EPOCH - 1}, but this host requires ${WORKSPACE_SYSTEM_EPOCH}`
    );
  });
});

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { WORKSPACE_SYSTEM_EPOCH } from "@vibestudio/shared/vcs/systemEpoch";
import { resolveDevelopmentTemplateSet } from "./developmentTemplateSet.js";

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
function fixture(epoch: number) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-template-set-"));
  roots.push(root);
  const templates = path.join(root, "templates");
  fs.mkdirSync(templates);
  for (const name of ["base", "personal", "system"] as const) {
    const checkout = path.join(templates, name);
    fs.mkdirSync(path.join(checkout, "meta"), { recursive: true });
    fs.mkdirSync(path.join(checkout, "packages", name), { recursive: true });
    fs.writeFileSync(
      path.join(checkout, "packages", name, "package.json"),
      JSON.stringify({ name: `@workspace/${name}` })
    );
    fs.writeFileSync(
      path.join(checkout, "meta", "vibestudio.yml"),
      `systemEpoch: ${epoch}\ntemplate:\n  name: ${name}\n  repositories: [packages/${name}]\n  files: []\n`
    );
    git(checkout, "init", "-b", "main");
    git(checkout, "add", ".");
    git(checkout, "commit", "-m", name);
    git(checkout, "remote", "add", "origin", `https://example.test/${name}.git`);
  }
  return { host: root, templates, checkpoint: path.join(root, "checkpoint") };
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("resolveDevelopmentTemplateSet", () => {
  it("snapshots each canonical template without projecting a source superset", async () => {
    const { host, templates, checkpoint } = fixture(WORKSPACE_SYSTEM_EPOCH);
    await expect(
      resolveDevelopmentTemplateSet({
        repoRoot: host,
        checkpointRoot: checkpoint,
        explicitRoot: templates,
      })
    ).resolves.toMatchObject({
      sourceCheckouts: {
        base: path.join(templates, "base"),
        personal: path.join(templates, "personal"),
        system: path.join(templates, "system"),
      },
      pins: {
        base: {
          ref: "refs/heads/vibestudio-dev-checkpoint",
          url: "git+https://example.test/base.git",
        },
        personal: {
          ref: "refs/heads/vibestudio-dev-checkpoint",
          url: "git+https://example.test/personal.git",
        },
        system: {
          ref: "refs/heads/vibestudio-dev-checkpoint",
          url: "git+https://example.test/system.git",
        },
      },
    });
  });

  it("rejects an incompatible template before startup", async () => {
    const { host, templates, checkpoint } = fixture(WORKSPACE_SYSTEM_EPOCH + 1);
    await expect(
      resolveDevelopmentTemplateSet({
        repoRoot: host,
        checkpointRoot: checkpoint,
        explicitRoot: templates,
      })
    ).rejects.toThrow(/systemEpoch/u);
  });
});

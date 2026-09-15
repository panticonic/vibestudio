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
  fs.writeFileSync(
    path.join(templates, "registry.json"),
    JSON.stringify({
      version: 1,
      templates: [
        ...["base", "personal", "system"].map((name) => ({
          id: name,
          role: name,
          name,
          description: `${name} template`,
          url: `git+https://example.test/${name}.git`,
        })),
        {
          id: "system-testing",
          role: "development",
          name: "System testing",
          description: "Acceptance harness",
          url: "git+https://example.test/system-testing.git",
          consumers: ["personal", "system"],
        },
        {
          id: "examples",
          role: "catalog",
          name: "Examples",
          description: "Examples template",
          url: "git+https://example.test/examples.git",
        },
      ],
    })
  );
  for (const name of ["base", "personal", "system", "system-testing", "examples"] as const) {
    const checkout = path.join(templates, name);
    fs.mkdirSync(path.join(checkout, "meta"), { recursive: true });
    fs.mkdirSync(path.join(checkout, "packages", name), { recursive: true });
    fs.writeFileSync(
      path.join(checkout, "packages", name, "package.json"),
      JSON.stringify({ name: `@workspace/${name}` })
    );
    fs.writeFileSync(
      path.join(checkout, "meta", "vibestudio.yml"),
      `systemEpoch: ${epoch}\ntemplate:\n  name: ${name}\n  repositories: [packages/${name}]\n`
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
  it("snapshots the complete official template universe without projecting a source superset", async () => {
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
        "system-testing": path.join(templates, "system-testing"),
        examples: path.join(templates, "examples"),
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
      sourcePins: {
        "system-testing": {
          ref: "refs/heads/vibestudio-dev-checkpoint",
          url: "git+https://example.test/system-testing.git",
        },
        examples: {
          ref: "refs/heads/vibestudio-dev-checkpoint",
          url: "git+https://example.test/examples.git",
        },
      },
    });
    const personalManifest = fs.readFileSync(
      path.join(checkpoint, "1", "meta", "vibestudio.yml"),
      "utf8"
    );
    expect(personalManifest).toContain("git+https://example.test/system-testing.git");
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

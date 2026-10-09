import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import { WORKSPACE_SYSTEM_EPOCH } from "@vibestudio/shared/vcs/systemEpoch";
import { serializeWorkspaceSources } from "@vibestudio/workspace/workspaceSources";
import type { ExactRepositorySnapshotPlan } from "../vcsHost/workspaceVcs.js";
import { sealDevelopmentWorkspaceSources } from "./developmentWorkspaceSources.js";

it("launches the exact semantic templates rather than the host's packaged release commits", async () => {
  const runRoot = await fs.mkdtemp(path.join(os.tmpdir(), "development-workspace-sources-"));
  const sourceRoot = path.join(runRoot, "source");
  const roles = ["base", "personal", "system"] as const;
  const designated = Object.fromEntries(
    roles.map((role) => [
      role,
      {
        url: `git+https://example.test/${role}.git`,
        ref: "refs/tags/old-release",
        commit: "a".repeat(40),
      },
    ])
  );
  try {
    await fs.mkdir(path.join(sourceRoot, "build-resources"), { recursive: true });
    await fs.writeFile(
      path.join(sourceRoot, "build-resources/workspace-template-release.json"),
      JSON.stringify({ format: "vibestudio-template-release/1", workspaceTemplates: designated })
    );
    const plans = Object.fromEntries(roles.map((role) => [role, { repositoryId: role }])) as Record<
      (typeof roles)[number],
      ExactRepositorySnapshotPlan
    >;
    const input = {
      runRoot,
      sourceRoot,
      plans,
      async materialize(plan: ExactRepositorySnapshotPlan, destination: string) {
        await fs.mkdir(path.join(destination, "meta"), { recursive: true });
        await fs.writeFile(
          path.join(destination, "meta/vibestudio.yml"),
          `systemEpoch: ${WORKSPACE_SYSTEM_EPOCH}\ntemplate:\n  name: ${plan.repositoryId}\n`
        );
        await fs.mkdir(path.join(destination, "projects/input"), { recursive: true });
        await fs.writeFile(
          path.join(destination, "projects/input/source.txt"),
          `${plan.repositoryId}: current semantic source`
        );
        await fs.writeFile(path.join(destination, "projects/input/.gitignore"), "ignored.txt\n");
        await fs.writeFile(
          path.join(destination, "projects/input/ignored.txt"),
          "tracked semantic source"
        );
      },
    };
    const first = await sealDevelopmentWorkspaceSources(input);
    expect(() => serializeWorkspaceSources(first.workspaceSources)).not.toThrow();
    for (const role of roles) {
      const pin = first.workspaceTemplates[role];
      expect(pin.url).toBe(designated[role]!.url);
      expect(pin.commit).not.toBe(designated[role]!.commit);
      const source = first.workspaceSources.find((source) => source.pin.url === pin.url)!;
      expect(
        execFileSync(
          "git",
          ["-C", source.checkout, "show", `${pin.commit}:projects/input/source.txt`],
          { encoding: "utf8" }
        )
      ).toBe(`${role}: current semantic source`);
      expect(
        execFileSync(
          "git",
          ["-C", source.checkout, "show", `${pin.commit}:projects/input/ignored.txt`],
          { encoding: "utf8" }
        )
      ).toBe("tracked semantic source");
      expect(source.checkout.startsWith(runRoot + path.sep)).toBe(true);
    }
    expect((await sealDevelopmentWorkspaceSources(input)).workspaceTemplates).toEqual(
      first.workspaceTemplates
    );
    await expect(fs.stat(path.join(runRoot, "template-inputs"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  } finally {
    await fs.rm(runRoot, { recursive: true, force: true });
  }
});

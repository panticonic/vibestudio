import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  readDefaultWorkspaceTemplates,
  type DefaultWorkspaceTemplates,
} from "@vibestudio/workspace/templateRelease";
import { templateGitTransportUrl } from "@vibestudio/workspace/templateCoordinates";
import type { WorkspaceSource } from "@vibestudio/workspace/workspaceSources";
import { inspectWorkspaceSources } from "../../workspaceTemplateSource.js";
import { CHECKPOINT_GIT_CONFIG } from "../../workspaceTemplateCheckpoint.js";
import type { ExactRepositorySnapshotPlan } from "../vcsHost/workspaceVcs.js";

const execute = promisify(execFile);
const roles = ["base", "personal", "system"] as const;

/** Project an exact semantic template composition onto ordinary immutable Git acquisition inputs. */
export async function sealDevelopmentWorkspaceSources(input: {
  sourceRoot: string;
  runRoot: string;
  plans: Record<(typeof roles)[number], ExactRepositorySnapshotPlan>;
  materialize(plan: ExactRepositorySnapshotPlan, destination: string): Promise<void>;
}): Promise<{
  workspaceTemplates: DefaultWorkspaceTemplates;
  workspaceSources: WorkspaceSource[];
}> {
  const designated = readDefaultWorkspaceTemplates(input.sourceRoot, {});
  const inputRoot = path.join(input.runRoot, "template-inputs");
  const checkpointRoot = path.join(input.runRoot, "template-checkpoints");
  await fs.rm(inputRoot, { recursive: true, force: true });
  await fs.mkdir(inputRoot, { recursive: true, mode: 0o700 });
  try {
    const checkouts: string[] = [];
    for (const role of roles) {
      const checkout = path.join(inputRoot, role);
      await fs.mkdir(checkout, { mode: 0o700 });
      await input.materialize(input.plans[role], checkout);
      const git = (args: string[]) =>
        execute("git", [...CHECKPOINT_GIT_CONFIG, "-C", checkout, ...args], {
          env: {
            ...process.env,
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
            GIT_AUTHOR_NAME: "Vibestudio Development",
            GIT_AUTHOR_EMAIL: "development@vibestudio.invalid",
            GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
            GIT_COMMITTER_NAME: "Vibestudio Development",
            GIT_COMMITTER_EMAIL: "development@vibestudio.invalid",
            GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
          },
        });
      await git(["init", "--initial-branch=main"]);
      await git(["remote", "add", "origin", templateGitTransportUrl(designated[role].url)]);
      // The semantic manifest already selected the source files, including
      // tracked files a native .gitignore would otherwise omit.
      await git(["add", "--force", "--all"]);
      await git(["commit", "--no-gpg-sign", "-m", "Exact development template source"]);
      checkouts.push(checkout);
    }
    const workspaceSources = (await inspectWorkspaceSources({ checkouts, checkpointRoot })).map(
      ({ pin, checkout, review }) => ({ pin, checkout, review })
    );
    const workspaceTemplates = Object.fromEntries(
      roles.map((role, index) => [role, workspaceSources[index]!.pin])
    ) as DefaultWorkspaceTemplates;
    return { workspaceTemplates, workspaceSources };
  } finally {
    // Only the immutable checkpoints are launch inputs. The projection used
    // to produce them is no longer a resource of the running child.
    await fs.rm(inputRoot, { recursive: true, force: true });
  }
}

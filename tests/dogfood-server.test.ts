// @ts-expect-error Script modules are plain .mjs and intentionally untyped.
import {
  bootstrapWorkspace,
  createDogfoodPairHooks,
  shouldRestart,
  workspaceDir,
} from "../scripts/start-dogfood-server.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import * as YAML from "yaml";

const tempRoots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "natstack-dogfood-test-"));
  tempRoots.push(root);
  return root;
}

function gitConfig(cwd: string, key: string): string {
  const result = spawnSync("git", ["-C", cwd, "config", "--get", key], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `git config ${key} failed`);
  }
  return result.stdout.trim();
}

describe("dogfood server supervisor", () => {
  it("classifies server-runtime changes as restart-worthy", () => {
    expect(shouldRestart(["src/server/index.ts"])).toBe(true);
    expect(shouldRestart(["packages/git-server/src/server.ts"])).toBe(true);
    expect(shouldRestart(["docs/remote-server.md", "README.md"])).toBe(false);
    expect(shouldRestart(["src/main/index.ts", "apps/mobile/App.tsx"])).toBe(false);
  });

  it("restarts after an applied self-update mirror event", () => {
    const hooks = createDogfoodPairHooks({ workspaceName: "dogfood-test" });
    const restart = vi.fn().mockResolvedValue(true);

    const handled = hooks.onServerLine(
      `[mirror] ${JSON.stringify({
        event: "applied",
        changedPaths: ["scripts/start-dogfood-server.mjs"],
      })}`,
      { restart }
    );

    expect(handled).toBe(true);
    expect(restart).toHaveBeenCalledTimes(1);
    expect(restart.mock.calls[0][0]).toEqual(expect.any(Function));
  });

  it("does not restart for doc-only mirror events", () => {
    const hooks = createDogfoodPairHooks({ workspaceName: "dogfood-test" });
    const restart = vi.fn().mockResolvedValue(true);

    const handled = hooks.onServerLine(
      `[mirror] ${JSON.stringify({
        event: "applied",
        changedPaths: ["docs/remote-server.md"],
      })}`,
      { restart }
    );

    expect(handled).toBe(true);
    expect(restart).not.toHaveBeenCalled();
  });

  it("prints recovery guidance when rebuild after self-update fails", () => {
    const hooks = createDogfoodPairHooks({ workspaceName: "dogfood-test" });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    hooks.onRestartError(new Error("build failed"));

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("DOGFOOD REBUILD FAILED"));
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("git reset --hard HEAD~1 && pnpm dev:self:server")
    );
    warnSpy.mockRestore();
  });

  it("bootstraps a dogfood project with the advertised gateway remote", () => {
    const configRoot = tmpRoot();
    vi.stubEnv("XDG_CONFIG_HOME", configRoot);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const remoteUrl = "http://100.90.80.70:3030/_git/projects/natstack";

    const wsDir = bootstrapWorkspace("dogfood-test", { gitRemoteUrl: remoteUrl });
    const projectDir = path.join(wsDir, "source", "projects", "natstack");

    expect(wsDir).toBe(workspaceDir("dogfood-test"));
    expect(gitConfig(projectDir, "remote.origin.url")).toBe(remoteUrl);
    const workspaceConfig = YAML.parse(
      fs.readFileSync(path.join(wsDir, "source", "meta", "natstack.yml"), "utf8")
    );
    expect(workspaceConfig.git.remotes.projects.natstack.origin).toBe(remoteUrl);
    const dogfoodMeta = JSON.parse(
      fs.readFileSync(path.join(wsDir, "source", "meta", "dogfood.json"), "utf8")
    );
    expect(dogfoodMeta.gitRemoteUrl).toBe(remoteUrl);
  });
});

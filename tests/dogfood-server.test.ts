// @ts-expect-error Script modules are plain .mjs and intentionally untyped.
import {
  bootstrapWorkspace,
  createDogfoodPairHooks,
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-dogfood-test-"));
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
  it("ignores mirror events under GAD VCS", () => {
    const hooks = createDogfoodPairHooks({ workspaceName: "dogfood-test" });
    const restart = vi.fn().mockResolvedValue(true);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const handled = hooks.onServerLine(
      `[mirror] ${JSON.stringify({
        event: "applied",
        changedPaths: ["scripts/start-dogfood-server.mjs"],
      })}`,
      { restart }
    );

    expect(handled).toBe(true);
    expect(restart).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("unsupported under GAD VCS"));
    warnSpy.mockRestore();
  });

  it("prints recovery guidance when rebuild fails", () => {
    const hooks = createDogfoodPairHooks({ workspaceName: "dogfood-test" });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    hooks.onRestartError(new Error("build failed"));

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("DOGFOOD REBUILD FAILED"));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("pnpm dev:self:server"));
    warnSpy.mockRestore();
  });

  it("registers the prepared dogfood workspace through the canonical hub bootstrap flag", () => {
    const hooks = createDogfoodPairHooks({ workspaceName: "dogfood-test" });
    const args = hooks.buildServerArgs({ port: 3456, appRoot: null }, "127.0.0.1");
    expect(args).toContain("--bootstrap-workspace");
    expect(args[args.indexOf("--bootstrap-workspace") + 1]).toBe("dogfood-test");
    expect(args).not.toContain("--workspace");
    expect(args).not.toContain("--print-credentials");

    const env = hooks.buildEnv({}, { options: { port: 3456 }, serverArgs: args });
    expect(env.VIBESTUDIO_GATEWAY_ALIASES).toBe(JSON.stringify(["http://127.0.0.1:3456"]));
  });

  it("bootstraps a dogfood project with the host checkout remote", () => {
    const configRoot = tmpRoot();
    vi.stubEnv("XDG_CONFIG_HOME", configRoot);
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const remoteUrl = tmpRoot();

    const wsDir = bootstrapWorkspace("dogfood-test", { gitRemoteUrl: remoteUrl });
    const projectDir = path.join(wsDir, "source", "projects", "vibestudio");

    expect(wsDir).toBe(workspaceDir("dogfood-test"));
    expect(gitConfig(projectDir, "remote.origin.url")).toBe(remoteUrl);
    const workspaceConfig = YAML.parse(
      fs.readFileSync(path.join(wsDir, "source", "meta", "vibestudio.yml"), "utf8")
    );
    expect(workspaceConfig.git.remotes.projects.vibestudio.origin).toEqual({ url: remoteUrl });
    const dogfoodMeta = JSON.parse(
      fs.readFileSync(path.join(wsDir, "source", "meta", "dogfood.json"), "utf8")
    );
    expect(dogfoodMeta.gitRemoteUrl).toBe(remoteUrl);
  });
});

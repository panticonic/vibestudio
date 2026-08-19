import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { claudeContainedSpawnEnvironment, confineClaudeReadOnly } from "./claudeReadOnlyLaunch.js";

function canCreateBubblewrapNamespace(): boolean {
  if (process.platform !== "linux" || !existsSync("/usr/bin/bwrap")) return false;
  const probe = spawnSync("/usr/bin/bwrap", ["--ro-bind", "/", "/", "--", "/bin/true"], {
    stdio: "ignore",
  });
  return probe.status === 0;
}

describe("confineClaudeReadOnly", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("mounts the host and context read-only with one explicit writable scratch root", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "claude-readonly-launch-"));
    roots.push(root);
    const profileDir = path.join(root, "launch-1");
    const contextDirectory = path.join(root, "context-1");
    const binDirectory = path.join(root, "bin");
    const bubblewrap = path.join(binDirectory, "bwrap");
    mkdirSync(binDirectory);
    writeFileSync(bubblewrap, "#!/bin/sh\nexit 0\n");
    chmodSync(bubblewrap, 0o700);
    const launch = confineClaudeReadOnly({
      argv: ["claude", "--channels", "server:vibestudio"],
      profileDir,
      contextDirectory,
      platform: "linux",
      pathValue: binDirectory,
    });

    expect(launch.command).toBe(bubblewrap);
    expect(launch.args).toEqual(
      expect.arrayContaining([
        "--ro-bind",
        "/",
        "/",
        "--ro-bind",
        contextDirectory,
        contextDirectory,
        "--bind",
        profileDir,
        profileDir,
      ])
    );
    expect(launch.args.slice(-3)).toEqual(["claude", "--channels", "server:vibestudio"]);
    expect(launch.scratchDirectory).toBe(path.join(profileDir, "scratch"));
    expect(launch.claudeConfigDirectory).toBe(path.join(profileDir, "claude-config"));
    expect(launch.env).toEqual({
      TMPDIR: "/tmp",
      VIBESTUDIO_LINKED_SCRATCH: path.join(profileDir, "scratch"),
      CLAUDE_CONFIG_DIR: path.join(profileDir, "claude-config"),
    });
  });

  it("fails closed without the audited OS backend", () => {
    expect(() =>
      confineClaudeReadOnly({
        argv: ["claude"],
        profileDir: "/state/launch-1",
        contextDirectory: "/workspace/context-1",
        platform: "darwin",
      })
    ).toThrow(/no backend is supported/);
    expect(() =>
      confineClaudeReadOnly({
        argv: ["claude"],
        profileDir: "/state/launch-1",
        contextDirectory: "/workspace/context-1",
        platform: "linux",
        pathValue: "",
      })
    ).toThrow(/requires bubblewrap/);
  });

  it("allows runtime coordinates while excluding ambient credentials and agent sockets", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "claude-contained-env-"));
    roots.push(root);
    const env = claudeContainedSpawnEnvironment({
      profileDir: path.join(root, "profile"),
      launchEnv: {
        VIBESTUDIO_ENTITY_ID: "entity-1",
        VIBESTUDIO_VESSEL_REF: "do:linked:one",
        VIBESTUDIO_AGENT_TOKEN: "smuggled-launch-secret",
      },
      confinementEnv: { CLAUDE_CONFIG_DIR: path.join(root, "profile", "claude-config") },
      ambient: {
        PATH: "/runtime/bin:/usr/bin",
        TERM: "xterm-256color",
        LANG: "en_US.UTF-8",
        LC_TIME: "de_DE.UTF-8",
        HTTPS_PROXY: "http://proxy.example:8080",
        https_proxy: "https://lower-proxy.example:8443",
        HTTP_PROXY: "http://user:secret@proxy.example:8080",
        SSL_CERT_FILE: "/etc/ssl/certs/ca-certificates.crt",
        VIBESTUDIO_AGENT_TOKEN: "agent:secret",
        VIBESTUDIO_SERVER_TOKEN: "server-secret",
        VIBESTUDIO_EXTENSION_RPC_TOKEN: "extension-secret",
        VIBESTUDIO_EXTENSION_GATEWAY_URL: "http://extension.internal",
        ANTHROPIC_API_KEY: "provider-secret",
        ANTHROPIC_AUTH_TOKEN: "provider-auth-secret",
        CLAUDE_CODE_OAUTH_TOKEN: "provider-oauth-secret",
        OPENAI_API_KEY: "other-provider-secret",
        GOOGLE_API_KEY: "google-provider-secret",
        AWS_SECRET_ACCESS_KEY: "aws-provider-secret",
        SSH_AUTH_SOCK: "/run/user/1000/ssh-agent",
        GPG_AGENT_INFO: "gpg-secret",
        NODE_OPTIONS: "--require=/steal.js",
        UNRELATED_SECRET: "ambient-secret",
      },
    });
    expect(env).toMatchObject({
      PATH: "/runtime/bin:/usr/bin",
      TERM: "xterm-256color",
      LANG: "en_US.UTF-8",
      LC_TIME: "de_DE.UTF-8",
      HTTPS_PROXY: "http://proxy.example:8080",
      https_proxy: "https://lower-proxy.example:8443",
      SSL_CERT_FILE: "/etc/ssl/certs/ca-certificates.crt",
      VIBESTUDIO_ENTITY_ID: "entity-1",
      VIBESTUDIO_VESSEL_REF: "do:linked:one",
    });
    expect(env["HOME"]).toBe(path.join(root, "profile", "home"));
    for (const secret of [
      "VIBESTUDIO_AGENT_TOKEN",
      "VIBESTUDIO_SERVER_TOKEN",
      "VIBESTUDIO_EXTENSION_RPC_TOKEN",
      "VIBESTUDIO_EXTENSION_GATEWAY_URL",
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "OPENAI_API_KEY",
      "GOOGLE_API_KEY",
      "AWS_SECRET_ACCESS_KEY",
      "SSH_AUTH_SOCK",
      "GPG_AGENT_INFO",
      "NODE_OPTIONS",
      "UNRELATED_SECRET",
      "HTTP_PROXY",
    ]) {
      expect(env).not.toHaveProperty(secret);
    }
  });

  it.runIf(canCreateBubblewrapNamespace())(
    "enforces EROFS for native context writes while explicit scratch stays writable",
    () => {
      const root = mkdtempSync(path.join(os.tmpdir(), "claude-readonly-exec-"));
      roots.push(root);
      const profileDir = path.join(root, "profile");
      const contextDirectory = path.join(root, "context");
      mkdirSync(profileDir);
      mkdirSync(contextDirectory);
      const launch = confineClaudeReadOnly({
        argv: ["/bin/sh", "-c", 'touch "$VIBESTUDIO_LINKED_SCRATCH/allowed"; touch ./blocked'],
        profileDir,
        contextDirectory,
      });

      const result = spawnSync(launch.command, launch.args, {
        env: claudeContainedSpawnEnvironment({
          profileDir,
          launchEnv: {},
          confinementEnv: launch.env,
        }),
        encoding: "utf8",
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/Read-only file system/);
      expect(existsSync(path.join(launch.scratchDirectory, "allowed"))).toBe(true);
      expect(existsSync(path.join(contextDirectory, "blocked"))).toBe(false);
    }
  );
});

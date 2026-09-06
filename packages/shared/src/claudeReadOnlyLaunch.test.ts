import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { claudeContainedSpawnEnvironment, confineClaudeReadOnly } from "./claudeReadOnlyLaunch.js";

function canRunMxc(): boolean {
  if (process.platform !== "linux" || !existsSync(launcher)) return false;
  if (spawnSync("slirp4netns", ["--version"], { stdio: "ignore" }).status !== 0) return false;
  return true;
}

const launcher = path.resolve(
  "dist/mxc",
  `${process.platform}-${process.arch}`,
  process.platform === "win32"
    ? "wxc-exec.exe"
    : process.platform === "darwin"
      ? "mxc-exec-mac"
      : "lxc-exec"
);

describe("confineClaudeReadOnly", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("declares network-capable linked-provider policy with explicit filesystem resources", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "claude-mxc-policy-"));
    roots.push(root);
    const profileDir = path.join(root, "profile");
    const contextDirectory = path.join(root, "context");
    const launch = confineClaudeReadOnly({
      argv: ["/runtime/claude", "argument with ' and $shell"],
      profileDir,
      contextDirectory,
      platform: "linux",
      launcher: "/installed/mxc",
      readPaths: ["/runtime"],
      launchEnv: {},
    });
    const config = JSON.parse(Buffer.from(launch.args[1]!, "base64").toString());
    expect(launch.command).toBe("/installed/mxc");
    expect(config.filesystem).toEqual({
      readonlyPaths: ["/runtime", contextDirectory],
      readwritePaths: [profileDir],
    });
    expect(config.network).toEqual({
      egress: { default: "allow" },
      ingress: { default: "deny", hostLoopback: "deny" },
    });
    expect(config.process.env).toContain(`HOME=${path.join(profileDir, "home")}`);
    expect(config.process.commandLine).toContain("$shell");
    expect(config.process.env).toContain(`TMPDIR=${path.join(profileDir, "tmp")}`);
    expect(launch.env).not.toHaveProperty("HOME");
    expect(launch.env).not.toHaveProperty("TMPDIR");
  });

  it("rejects host-root grants and overlapping writable profiles before provisioning", () => {
    const input = {
      argv: ["/runtime/claude"],
      profileDir: "/state/profile",
      contextDirectory: "/context",
      launcher: "/installed/mxc",
      readPaths: ["/runtime"],
      launchEnv: {},
      platform: "linux" as const,
    };
    expect(() => confineClaudeReadOnly({ ...input, readPaths: ["/"] })).toThrow(
      /below the host root/
    );
    expect(() => confineClaudeReadOnly({ ...input, readPaths: ["/runtime", "/state"] })).toThrow(
      /disjoint/
    );
    expect(() => confineClaudeReadOnly({ ...input, platform: "freebsd" })).toThrow(/unsupported/);
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

  it.runIf(canRunMxc())(
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
        launcher,
        readPaths: ["/bin/sh"],
        launchEnv: {},
      });

      const result = spawnSync(launch.command, launch.args, {
        env: launch.env,
        encoding: "utf8",
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/Read-only file system/);
      expect(existsSync(path.join(launch.scratchDirectory, "allowed"))).toBe(true);
      expect(existsSync(path.join(contextDirectory, "blocked"))).toBe(false);
    }
  );
});

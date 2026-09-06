import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { claudeSpawnEnvironment, prepareClaudeNativeLaunch } from "./claudeNativeLaunch.js";

function canRunMxc(): boolean {
  if (process.platform !== "linux" || !existsSync(launcher)) return false;
  return true;
}

// This optional execution probe exercises the Linux read-only mount contract.
const launcher = path.resolve("dist/mxc", `linux-${process.arch}`, "lxc-exec");

describe("prepareClaudeNativeLaunch", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("compiles the native platform contract with explicit profile and runtime resources", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "claude-native-policy-"));
    roots.push(root);
    const profileDir = path.join(root, "profile");
    const contextDirectory = path.join(root, "context");
    const platform = process.platform;
    if (platform !== "linux" && platform !== "darwin" && platform !== "win32")
      throw new Error(`Unsupported test platform: ${platform}`);
    const executable = path.join(root, "runtime", platform === "win32" ? "claude.exe" : "claude");
    const args = ["", "argument with ' and $shell", 'quote"and&operator', "trailing\\"];
    const installedLauncher = path.join(root, "installed", "mxc");
    const launch = prepareClaudeNativeLaunch({
      argv: [executable, ...args],
      profileDir,
      contextDirectory,
      installation:
        platform === "win32"
          ? { platform, mechanism: "host-process" }
          : { platform, mechanism: "mxc-process", launcher: installedLauncher },
      readPaths: [path.dirname(executable)],
      launchEnv: { VIBESTUDIO_ENTITY_ID: "entity", ANTHROPIC_API_KEY: "unprovisioned-secret" },
    });
    if (platform === "win32") {
      expect(launch.command).toBe(executable);
      expect(launch.args).toEqual(args);
      expect(launch.env["HOME"]).toBe(path.join(profileDir, "home"));
      expect(launch.env["TMPDIR"]).toBe(path.join(profileDir, "tmp"));
      expect(launch.env["VIBESTUDIO_ENTITY_ID"]).toBe("entity");
      expect(launch.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    } else {
      const config = JSON.parse(Buffer.from(launch.args[1]!, "base64").toString());
      expect(launch.command).toBe(installedLauncher);
      expect(config.filesystem).toEqual({
        readonlyPaths: [path.dirname(executable), contextDirectory],
        readwritePaths: [profileDir, ...(platform === "darwin" ? ["/dev"] : [])],
      });
      expect(config.network).toEqual({ defaultPolicy: "allow", allowLocalNetwork: true });
      expect(config.process.env).toContain(`HOME=${path.join(profileDir, "home")}`);
      expect(config.process.env).toContain(`TMPDIR=${path.join(profileDir, "tmp")}`);
      expect(config.process.env).toContain("VIBESTUDIO_ENTITY_ID=entity");
      expect(config.process.env).not.toContain("ANTHROPIC_API_KEY=unprovisioned-secret");
      expect(config.process.commandLine).toContain("$shell");
      expect(launch.env["HOME"]).toBe(process.env["HOME"]);
      expect(launch.env["TMPDIR"]).toBe(process.env["TMPDIR"]);
    }
    expect(existsSync(launch.scratchDirectory)).toBe(true);
    expect(existsSync(launch.claudeConfigDirectory)).toBe(true);
  });

  it("rejects host-root grants and overlapping writable profiles before provisioning", () => {
    const input = {
      argv: ["/runtime/claude"],
      profileDir: "/state/profile",
      contextDirectory: "/context",
      installation: {
        platform: "linux" as const,
        mechanism: "mxc-process" as const,
        launcher: "/installed/mxc",
      },
      readPaths: ["/runtime"],
      launchEnv: {},
    };
    expect(() => prepareClaudeNativeLaunch({ ...input, readPaths: ["/"] })).toThrow(
      /below the host root/
    );
    expect(() =>
      prepareClaudeNativeLaunch({ ...input, readPaths: ["/runtime", "/state"] })
    ).toThrow(/disjoint/);
  });

  it("allows runtime coordinates while excluding ambient credentials and agent sockets", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "claude-contained-env-"));
    roots.push(root);
    const env = claudeSpawnEnvironment({
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
      const launch = prepareClaudeNativeLaunch({
        argv: ["/bin/sh", "-c", 'touch "$VIBESTUDIO_LINKED_SCRATCH/allowed"; touch ./blocked'],
        profileDir,
        contextDirectory,
        installation: { platform: "linux", mechanism: "mxc-process", launcher },
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

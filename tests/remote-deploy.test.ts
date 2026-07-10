// @ts-expect-error Script modules are plain .mjs and intentionally untyped.
import { deploy, main, parseArgs } from "../scripts/cli/remote-deploy.mjs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type RunCall = {
  command: string;
  args: string[];
  options?: { input?: string };
};

/** The remote script is fed to `bash -l -s` over stdin, so it lands in options.input. */
function sshScripts(calls: RunCall[]): string[] {
  return calls
    .filter((call) => call.command === "ssh")
    .map((call) => call.options?.input ?? "");
}

/** POSIX-parse each generated remote script — catches quoting/heredoc regressions. */
function assertShellParses(script: string): void {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "vibestudio-shn-")), "script.sh");
  fs.writeFileSync(file, script);
  execFileSync("sh", ["-n", file]);
}

/** Extract the systemd unit heredoc body from the service-install script. */
function extractUnit(serviceScript: string): string {
  const match = serviceScript.match(/<<UNIT\n([\s\S]*?)\nUNIT/);
  if (!match) throw new Error("no UNIT heredoc found in service script");
  return match[1];
}

describe("remote-deploy CLI", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses deploy options without mutating the caller's argv", () => {
    const argv = ["deploy@example.test", "--workspace", "notes", "--port", "3035"];

    expect(parseArgs(argv)).toMatchObject({
      verb: "deploy",
      target: "deploy@example.test",
      workspace: "notes",
      port: "3035",
    });
    expect(argv).toEqual(["deploy@example.test", "--workspace", "notes", "--port", "3035"]);
  });

  it("parses the remove --purge flag", () => {
    expect(parseArgs(["remove", "deploy@example.test", "--purge"])).toMatchObject({
      verb: "remove",
      target: "deploy@example.test",
      purge: true,
    });
  });

  it("writes a valid systemd user service then mints and doctors a child workspace invite", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const calls: RunCall[] = [];
    const run = vi.fn(async (command: string, args: string[], options?: { input?: string }) => {
      calls.push({ command, args, options });
    });

    await deploy(
      {
        verb: "deploy",
        target: "deploy@example.test",
        artifact: null,
        signalUrl: "wss://signal.example.test",
        port: "3035",
        workspace: "notes",
        help: false,
      },
      { run }
    );

    // Every remote call goes through `ssh <target> bash -l -s` (single stdin
    // stream — no ssh-side re-parse of the multi-line script).
    expect(calls.every((call) => call.command === "ssh")).toBe(true);
    for (const call of calls) {
      expect(call.args).toEqual(["deploy@example.test", "bash", "-l", "-s"]);
    }

    const [preflight, install, service, postStart] = sshScripts(calls);

    // Every generated script must be a genuinely valid shell program.
    for (const script of [preflight, install, service, postStart]) {
      expect(script.startsWith("set -e\n")).toBe(true);
      assertShellParses(script);
    }

    expect(preflight).toContain("systemctl --user --version");
    expect(preflight).toContain("loginctl enable-linger");
    expect(install).toContain("npm install -g '@panticonic/vibestudio-server@");

    // Service install writes the unit, resolves the ABSOLUTE binary path, and
    // restarts (so an update replaces the old running binary).
    expect(service).toContain("cat > $HOME/.config/systemd/user/vibestudio-server.service");
    expect(service).toContain('VIBESTUDIO_BIN="$(command -v vibestudio || true)"');
    expect(service).toContain("systemctl --user restart vibestudio-server.service");

    const unit = extractUnit(service);
    expect(unit).toContain(
      "Environment=VIBESTUDIO_WEBRTC_IDENTITY=%h/.config/vibestudio/webrtc/identity.pem"
    );
    // Signal URL is validated+normalized (trailing slash) and quoted for systemd.
    expect(unit).toContain('Environment="VIBESTUDIO_WEBRTC_SIGNAL_URL=wss://signal.example.test/"');
    // ExecStart uses the resolved absolute path and sits on its OWN line (regression:
    // a literal "\n" collapsed it onto the Environment line → "no ExecStart").
    expect(unit).toMatch(/\nExecStart=\$\{VIBESTUDIO_BIN\} remote serve --port 3035\n/);
    expect(unit).not.toContain("\\nExecStart");
    expect(unit).toContain("Restart=always");

    // Readiness poll before the invite, then invite + doctor against the child
    // identity path with $HOME expanded (double-quoted, not single-quoted).
    expect(postStart).toContain("/healthz");
    expect(postStart).toContain("remote invite --port 3035 --workspace 'notes'");
    // The child-identity path must be double-quoted for $HOME expansion, never a
    // single-quoted literal.
    expect(postStart).toContain(
      `CHILD_IDENTITY="$HOME/.config/vibestudio/workspaces/notes/state/webrtc/identity.pem"`
    );
    expect(postStart).toContain(`remote doctor --signal-url 'wss://signal.example.test/' --identity "$CHILD_IDENTITY"`);
    expect(postStart).not.toContain(
      "'$HOME/.config/vibestudio/workspaces/notes/state/webrtc/identity.pem'"
    );
  });

  it("omits the signaling Environment line when no --signal-url is given", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const calls: RunCall[] = [];
    const run = vi.fn(async (command: string, args: string[], options?: { input?: string }) => {
      calls.push({ command, args, options });
    });

    await deploy(
      {
        verb: "deploy",
        target: "deploy@example.test",
        artifact: null,
        signalUrl: null,
        port: "3030",
        workspace: null,
        help: false,
      },
      { run }
    );

    const service = sshScripts(calls)[2];
    const unit = extractUnit(service);
    expect(unit).not.toContain("VIBESTUDIO_WEBRTC_SIGNAL_URL");
    expect(unit).toMatch(/\nExecStart=\$\{VIBESTUDIO_BIN\} remote serve --port 3030\n/);
  });

  it("rejects invalid workspace names before touching SSH", async () => {
    const run = vi.fn(async () => undefined);

    await expect(
      deploy(
        {
          verb: "deploy",
          target: "deploy@example.test",
          artifact: null,
          signalUrl: null,
          port: "3035",
          workspace: "../bad",
          help: false,
        },
        { run }
      )
    ).rejects.toThrow(/workspace name/);
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects an invalid --signal-url before touching SSH", async () => {
    const run = vi.fn(async () => undefined);

    await expect(
      deploy(
        {
          verb: "deploy",
          target: "deploy@example.test",
          artifact: null,
          signalUrl: "http://public.example.test",
          port: "3030",
          workspace: null,
          help: false,
        },
        { run }
      )
    ).rejects.toThrow(/signal-url/);
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range --port before touching SSH", async () => {
    const run = vi.fn(async () => undefined);

    await expect(
      deploy(
        {
          verb: "deploy",
          target: "deploy@example.test",
          artifact: null,
          signalUrl: null,
          port: "0",
          workspace: null,
          help: false,
        },
        { run }
      )
    ).rejects.toThrow(/port/);
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects an SSH target that looks like an option flag", async () => {
    const run = vi.fn(async () => undefined);

    await expect(
      deploy(
        {
          verb: "deploy",
          target: "-oProxyCommand=touch pwned",
          artifact: null,
          signalUrl: null,
          port: "3030",
          workspace: null,
          help: false,
        },
        { run }
      )
    ).rejects.toThrow(/option flag/);
    expect(run).not.toHaveBeenCalled();
  });

  it("routes status through the mocked SSH runner over stdin", async () => {
    const calls: RunCall[] = [];

    await main(["status", "deploy@example.test"], {
      run: async (command: string, args: string[], options?: { input?: string }) => {
        calls.push({ command, args, options });
      },
    });

    expect(calls).toEqual([
      {
        command: "ssh",
        args: ["deploy@example.test", "bash", "-l", "-s"],
        options: { input: "systemctl --user --no-pager status vibestudio-server.service" },
      },
    ]);
  });

  it("purge remove uninstalls the package and clears identity material", async () => {
    const calls: RunCall[] = [];
    await main(["remove", "deploy@example.test", "--purge"], {
      run: async (command: string, args: string[], options?: { input?: string }) => {
        calls.push({ command, args, options });
      },
    });
    const script = calls[0]?.options?.input ?? "";
    assertShellParses(script);
    expect(script).toContain("npm uninstall -g @panticonic/vibestudio-server");
    expect(script).toContain("rm -rf $HOME/.config/vibestudio/webrtc");
  });

  it("plain remove keeps the package but warns about leftovers", async () => {
    const calls: RunCall[] = [];
    await main(["remove", "deploy@example.test"], {
      run: async (command: string, args: string[], options?: { input?: string }) => {
        calls.push({ command, args, options });
      },
    });
    const script = calls[0]?.options?.input ?? "";
    assertShellParses(script);
    expect(script).not.toContain("npm uninstall");
    expect(script).toContain("--purge");
  });
});

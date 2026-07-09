// @ts-expect-error Script modules are plain .mjs and intentionally untyped.
import { deploy, main, parseArgs } from "../scripts/cli/remote-deploy.mjs";
import { afterEach, describe, expect, it, vi } from "vitest";

type RunCall = {
  command: string;
  args: string[];
};

function sshScripts(calls: RunCall[]): string[] {
  return calls
    .filter((call) => call.command === "ssh")
    .map((call) => call.args[3] ?? "");
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

  it("writes a systemd user service then mints and doctors a child workspace invite", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const calls: RunCall[] = [];
    const run = vi.fn(async (command: string, args: string[]) => {
      calls.push({ command, args });
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

    expect(calls.every((call) => call.command === "ssh")).toBe(true);
    expect(calls.map((call) => call.args.slice(0, 3))).toEqual([
      ["deploy@example.test", "bash", "-lc"],
      ["deploy@example.test", "bash", "-lc"],
      ["deploy@example.test", "bash", "-lc"],
      ["deploy@example.test", "bash", "-lc"],
    ]);

    const [preflight, install, service, postStart] = sshScripts(calls);
    expect(preflight).toContain("systemctl --user --version");
    expect(preflight).toContain("loginctl enable-linger");
    expect(install).toContain("npm install -g '@panticonic/vibestudio-server@");
    expect(service).toContain("cat > $HOME/.config/systemd/user/vibestudio-server.service");
    expect(service).toContain(
      "Environment=VIBESTUDIO_WEBRTC_IDENTITY=%h/.config/vibestudio/webrtc/identity.pem"
    );
    expect(service).toContain(
      "Environment=VIBESTUDIO_WEBRTC_SIGNAL_URL=wss://signal.example.test\\nExecStart=vibestudio remote serve --port '3035'"
    );
    expect(service).toContain("systemctl --user enable --now vibestudio-server.service");
    expect(postStart).toContain("vibestudio remote invite --port '3035' --workspace 'notes'");
    expect(postStart).toContain(
      "vibestudio remote doctor --signal-url 'wss://signal.example.test' --identity '$HOME/.config/vibestudio/workspaces/notes/state/webrtc/identity.pem'"
    );
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

  it("routes status through the mocked SSH runner", async () => {
    const calls: RunCall[] = [];

    await main(["status", "deploy@example.test"], {
      run: async (command: string, args: string[]) => {
        calls.push({ command, args });
      },
    });

    expect(calls).toEqual([
      {
        command: "ssh",
        args: [
          "deploy@example.test",
          "bash",
          "-lc",
          "systemctl --user --no-pager status vibestudio-server.service",
        ],
      },
    ]);
  });
});

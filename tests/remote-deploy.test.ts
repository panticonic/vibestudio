// @ts-expect-error Script modules are plain .mjs and intentionally untyped.
import { deploy, main, parseArgs, REQUIRED_NODE_VERSION } from "../scripts/cli/remote-deploy.mjs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

type RunCall = {
  command: string;
  args: string[];
  options?: { input?: string };
};

function sshScripts(calls: RunCall[]): string[] {
  return calls.filter((call) => call.command === "ssh").map((call) => call.options?.input ?? "");
}

describe("remote-deploy CLI", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses deploy options without mutating the caller's argv", () => {
    const argv = ["deploy@example.test", "--port", "3035"];

    expect(parseArgs(argv)).toMatchObject({
      verb: "deploy",
      target: "deploy@example.test",
      port: "3035",
    });
    expect(argv).toEqual(["deploy@example.test", "--port", "3035"]);
  });

  it("enforces the package Node engine, writes the service, and runs diagnostics", async () => {
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
        help: false,
      },
      { run }
    );

    expect(calls.every((call) => call.command === "ssh")).toBe(true);
    expect(calls.every((call) => call.args.length === 4)).toBe(true);
    expect(calls.every((call) => call.args[0] === "deploy@example.test")).toBe(true);
    expect(calls.every((call) => call.args.slice(1).join(" ") === "bash -l -s")).toBe(true);

    const [preflight, install, service, postStart] = sshScripts(calls);
    expect(REQUIRED_NODE_VERSION).toEqual([22, 19, 0]);
    expect(preflight).toContain("Node.js 22.19.0+");
    expect(preflight).toContain("actual[1]===required[1]");
    expect(preflight).toContain("systemctl --user --version");
    expect(preflight).toContain("loginctl enable-linger");
    expect(install).toContain("npm install -g '@panticonic/vibestudio-server@");
    expect(service).toContain("cat > $HOME/.config/systemd/user/vibestudio-server.service");
    expect(service).not.toContain("VIBESTUDIO_WEBRTC_IDENTITY");
    expect(service).toContain(
      'Environment="VIBESTUDIO_WEBRTC_SIGNAL_URL=wss://signal.example.test"\nExecStart=__NODE_BIN__ __VIBESTUDIO_ENTRY__ remote serve --port 3035'
    );
    expect(service).toContain("node_bin=$(command -v node)");
    expect(service).toContain("vibestudio_bin=$(command -v vibestudio)");
    expect(service).toContain('vibestudio_entry=$(readlink -f "$vibestudio_bin")');
    expect(service).toContain(
      'sed -i "s|__NODE_BIN__|$node_bin|g; s|__VIBESTUDIO_ENTRY__|$vibestudio_entry|g" $HOME/.config/systemd/user/vibestudio-server.service'
    );
    expect(service).not.toContain('Environment="PATH=');
    expect(service).toContain("systemctl --user restart vibestudio-server.service");
    expect(service).toContain("fetch('http://127.0.0.1:3035/healthz')");
    expect(service).toContain("Timed out waiting for the hub and default workspace identity");
    expect(postStart).toContain("journalctl --user -u vibestudio-server.service -n 100 --no-pager");
    expect(postStart).toContain(
      '"$node_bin" "$vibestudio_entry" remote doctor --signal-url \'wss://signal.example.test\' --identity $HOME/.config/vibestudio/workspaces/default/state/webrtc/identity.pem'
    );
  });

  it("rejects the removed deployment-time workspace flag", () => {
    expect(() => parseArgs(["deploy@example.test", "--workspace", "notes"])).toThrow(
      /Unknown argument/
    );
  });

  it("validates deployment ports and signaling values before SSH", () => {
    expect(() => parseArgs(["deploy@example.test", "--port", "0"])).toThrow(/1 to 65535/);
    expect(() =>
      parseArgs(["deploy@example.test", "--signal-url", "wss://user:secret@signal.test"])
    ).toThrow(/must not contain credentials/);
    expect(() =>
      parseArgs(["deploy@example.test", "--signal-url", "wss://signal.test\nINJECTED"])
    ).toThrow(/control characters/);
  });

  it("rejects SSH option injection and parses destructive purge explicitly", () => {
    expect(() => parseArgs(["-oProxyCommand=bad"])).not.toThrow();
    expect(parseArgs(["remove", "deploy@example.test", "--purge"])).toMatchObject({
      verb: "remove",
      purge: true,
    });
  });

  it("routes status through the mocked SSH runner", async () => {
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

  it("returns a non-zero process status when the direct CLI has no target", () => {
    const result = spawnSync(
      process.execPath,
      [path.join(process.cwd(), "scripts", "cli", "remote-deploy.mjs")],
      { encoding: "utf8" }
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("vibestudio remote deploy");
  });
});

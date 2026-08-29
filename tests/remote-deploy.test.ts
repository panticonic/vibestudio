// @ts-expect-error Script modules are plain .mjs and intentionally untyped.
import { deploy, main, parseArgs, REQUIRED_NODE_VERSION } from "../scripts/cli/remote-deploy.mjs";
import { afterEach, describe, expect, it, vi } from "vitest";

type RunCall = { command: string; args: string[]; options?: { input?: string } };

afterEach(() => vi.restoreAllMocks());

describe("remote-deploy CLI", () => {
  it("uses the production relay set unless explicit canonical relays are supplied", () => {
    expect(parseArgs(["host"]).relayUrls).toEqual([
      "https://use1-1.relay.n0.iroh.link/",
      "https://euc1-1.relay.n0.iroh.link/",
    ]);
    expect(
      parseArgs([
        "host",
        "--relay-url",
        "https://one.example/",
        "--relay-url",
        "https://two.example/",
      ]).relayUrls
    ).toEqual(["https://one.example/", "https://two.example/"]);
    expect(() => parseArgs(["host", "--relay-url", "http://relay.example/"])).toThrow(
      /canonical.*HTTPS/
    );
    expect(() => parseArgs(["host", "--relay-url", "https://user:secret@relay.example/"])).toThrow(
      /canonical.*HTTPS/
    );
  });

  it("installs an explicit Iroh relay set in the systemd service and doctors both endpoints", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const calls: RunCall[] = [];
    await deploy(
      {
        verb: "deploy",
        target: "deploy@example.test",
        artifact: null,
        relayUrls: ["https://one.example/", "https://two.example/"],
        port: "3035",
        purge: false,
        help: false,
      },
      {
        run: async (command: string, args: string[], options?: { input?: string }) =>
          void calls.push({ command, args, options }),
      }
    );
    expect(REQUIRED_NODE_VERSION).toEqual([22, 19, 0]);
    const scripts = calls.map((call) => call.options?.input ?? "");
    expect(scripts.join("\n")).toContain(
      'Environment="VIBESTUDIO_IROH_RELAYS=https://one.example/,https://two.example/"'
    );
    expect(scripts.join("\n")).toContain(
      "remote doctor --relay-url 'https://one.example/' --relay-url 'https://two.example/'"
    );
    expect(scripts.join("\n")).toContain(
      "remote doctor --relay-url 'https://one.example/' --relay-url 'https://two.example/' --workspace default"
    );
    expect(scripts.join("\n")).not.toContain("signal-url");
  });

  it("routes service status through the isolated target shell", async () => {
    const calls: RunCall[] = [];
    await main(["status", "deploy@example.test"], {
      run: async (command: string, args: string[], options?: { input?: string }) =>
        void calls.push({ command, args, options }),
    });
    expect(calls).toEqual([
      {
        command: "ssh",
        args: ["deploy@example.test", "bash", "-l", "-s"],
        options: { input: "systemctl --user --no-pager status vibestudio-server.service" },
      },
    ]);
  });

  it("purges only workspace endpoint secrets and leaves hub trust intact", async () => {
    const calls: RunCall[] = [];
    await main(["remove", "host", "--purge"], {
      run: async (command: string, args: string[], options?: { input?: string }) =>
        void calls.push({ command, args, options }),
    });
    const script = calls[0]?.options?.input ?? "";
    expect(script).toContain("*/reach/iroh/endpoint.key");
    expect(script).not.toContain("server-auth/iroh");
  });
});

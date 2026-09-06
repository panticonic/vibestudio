import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { compileMxcLaunch, type MxcLaunchInput, mxcLauncherEnvironment } from "./mxc.js";

function input(platform: MxcLaunchInput["platform"] = "linux"): MxcLaunchInput {
  return {
    platform,
    network: "allow",
    launcher: platform === "win32" ? "C:\\installed\\mxc.exe" : "/installed/mxc",
    containerId: "test",
    argv: [platform === "win32" ? "C:\\runtime\\node.exe" : process.execPath],
    cwd: platform === "win32" ? "C:\\guest" : "/guest",
    guestEnvironment:
      platform === "win32"
        ? { HOME: "C:\\guest\\home", LOCALAPPDATA: "C:\\guest\\local" }
        : { HOME: "/guest/home", LOCALAPPDATA: "/guest/local" },
    readPaths: [],
    writePaths: [],
  };
}
function config(value: MxcLaunchInput) {
  return JSON.parse(Buffer.from(compileMxcLaunch(value).args[1]!, "base64").toString());
}

describe("stock MXC adapter", () => {
  it("keeps trusted helper discovery and Windows ACL journal coordinates outside the guest", () => {
    const host = {
      PATH: "C:\\tools",
      SystemRoot: "C:\\Windows",
      USERPROFILE: "C:\\owner",
      LOCALAPPDATA: "C:\\owner\\local",
      HOME: "host-home",
      TOKEN: "secret",
    };
    const launch = compileMxcLaunch(input("win32"), host);
    expect(launch.environment).toEqual(host);
    expect(JSON.parse(Buffer.from(launch.args[1]!, "base64").toString()).process.env).toContain(
      "LOCALAPPDATA=C:\\guest\\local"
    );
    expect(JSON.parse(Buffer.from(launch.args[1]!, "base64").toString()).process.env).not.toContain(
      "TOKEN=secret"
    );
    expect(mxcLauncherEnvironment(host)).toEqual(host);
  });

  it.runIf(process.platform !== "win32")("round trips shell metacharacters as literal argv", () => {
    const args = [
      "",
      "space and ' quote",
      'double " quote',
      "$(echo injected)",
      "`echo injected`",
      "line\nbreak",
      "back\\slash",
    ];
    const command = config({
      ...input(),
      argv: [
        process.execPath,
        "-e",
        "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
        ...args,
      ],
    }).process.commandLine;
    expect(JSON.parse(execFileSync("/bin/sh", ["-c", command], { encoding: "utf8" }))).toEqual(
      args
    );
  });

  it("encodes Windows CRT quotes and trailing backslashes", () => {
    const command = config({
      ...input("win32"),
      argv: ["C:\\runtime\\node.exe", "", "a b", 'a"b', "C:\\trailing\\"],
    }).process.commandLine;
    expect(command).toBe('"C:\\runtime\\node.exe" "" "a b" "a\\"b" "C:\\trailing\\\\"');
  });

  it.each(["linux", "darwin", "win32"] as const)(
    "uses stock open networking with unchanged filesystem/lifecycle policy on %s",
    (platform) => {
      const result = config(input(platform));
      expect(result.network).toEqual({ defaultPolicy: "allow", allowLocalNetwork: true });
      expect(result.lifecycle).toEqual({ destroyOnExit: true, preservePolicy: false });
      if (platform === "win32")
        expect(result.processContainer).toEqual({
          leastPrivilege: false,
          capabilities: ["internetClient", "internetClientServer", "privateNetworkClientServer"],
        });
      if (platform === "darwin")
        expect(result.seatbelt).toEqual({ nestedPty: true, keychainAccess: false });
    }
  );

  it.each(["linux", "darwin", "win32"] as const)(
    "keeps internal cleanup offline on %s",
    (platform) => {
      const result = config({ ...input(platform), network: "deny" });
      expect(result.network).toEqual({
        egress: { default: "deny" },
        ingress: { default: "deny", hostLoopback: "deny" },
      });
      if (platform === "win32") expect(result.processContainer.capabilities).toEqual([]);
    }
  );

  it("rejects data that cannot be represented safely and Windows script shims", () => {
    expect(() => compileMxcLaunch({ ...input("win32"), guestEnvironment: {} })).toThrow(
      /absolute private LOCALAPPDATA/
    );
    expect(() =>
      compileMxcLaunch({ ...input("win32"), guestEnvironment: { LOCALAPPDATA: "relative" } })
    ).toThrow(/absolute private LOCALAPPDATA/);
    expect(() =>
      compileMxcLaunch({
        ...input("win32"),
        guestEnvironment: { localappdata: "C:\\guest\\local" },
      })
    ).not.toThrow();
    expect(() => compileMxcLaunch({ ...input(), argv: ["bad\0argument"] })).toThrow(/NUL/);
    expect(() => compileMxcLaunch({ ...input(), guestEnvironment: { "BAD=KEY": "x" } })).toThrow(
      /environment/
    );
    expect(() => compileMxcLaunch({ ...input("win32"), argv: ["C:\\claude.cmd"] })).toThrow(
      /native Windows executable/
    );
    expect(() => compileMxcLaunch({ ...input(), launcher: "mxc" })).toThrow(
      /installed absolute path/
    );
  });
});

import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { compileMxcLaunch, type MxcLaunchInput, mxcLauncherEnvironment } from "./mxc.js";

function input(platform: MxcLaunchInput["platform"] = "linux"): MxcLaunchInput {
  return {
    platform,
    launcher: platform === "win32" ? "C:\\installed\\mxc.exe" : "/installed/mxc",
    containerId: "test",
    argv: [platform === "win32" ? "C:\\runtime\\node.exe" : process.execPath],
    cwd: platform === "win32" ? "C:\\guest" : "/guest",
    guestEnvironment: { HOME: "/guest/home", LOCALAPPDATA: "/guest/local" },
    readPaths: [],
    writePaths: [],
    network: "deny",
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
    expect(launch.environment).toEqual({
      PATH: host.PATH,
      SystemRoot: host.SystemRoot,
      USERPROFILE: host.USERPROFILE,
      LOCALAPPDATA: host.LOCALAPPDATA,
    });
    expect(JSON.parse(Buffer.from(launch.args[1]!, "base64").toString()).process.env).toContain(
      "LOCALAPPDATA=/guest/local"
    );
    expect(mxcLauncherEnvironment("linux", host)).toEqual({ PATH: host.PATH });
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
    "uses common stock defaults and explicit network choice on %s",
    (platform) => {
      const denied = config(input(platform));
      const allowed = config({ ...input(platform), network: "allow" });
      expect(denied.network).toEqual({
        egress: { default: "deny" },
        ingress: { default: "deny", hostLoopback: "deny" },
      });
      expect(allowed.network.egress.default).toBe("allow");
      expect(denied.lifecycle).toEqual({ destroyOnExit: true, preservePolicy: false });
      if (platform === "win32") {
        expect(denied.processContainer).toEqual({ leastPrivilege: false, capabilities: [] });
        expect(allowed.processContainer).toEqual({
          leastPrivilege: false,
          capabilities: ["internetClient"],
        });
      }
      if (platform === "darwin")
        expect(denied.seatbelt).toEqual({ nestedPty: true, keychainAccess: false });
    }
  );

  it("rejects data that cannot be represented safely and Windows script shims", () => {
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

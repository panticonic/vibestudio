import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { compileMxcLaunch, type MxcLaunchInput, mxcLauncherEnvironment } from "./mxc.js";

function input(platform: MxcLaunchInput["platform"] = "linux"): MxcLaunchInput {
  return {
    platform,
    network: "allow",
    launcher: "/installed/mxc",
    containerId: "test",
    argv: [process.execPath],
    cwd: "/guest",
    guestEnvironment: { HOME: "/guest/home" },
    readPaths: [],
    writePaths: [],
  };
}
function config(value: MxcLaunchInput) {
  return JSON.parse(Buffer.from(compileMxcLaunch(value).args[1]!, "base64").toString());
}

describe("stock MXC adapter", () => {
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

  it.each(["linux", "darwin"] as const)(
    "uses stock open networking with unchanged filesystem/lifecycle policy on %s",
    (platform) => {
      const result = config(input(platform));
      expect(result.network).toEqual({ defaultPolicy: "allow", allowLocalNetwork: true });
      expect(result.lifecycle).toEqual({ destroyOnExit: true, preservePolicy: false });
      if (platform === "darwin")
        expect(result.seatbelt).toEqual({
          nestedPty: true,
          keychainAccess: false,
          extraMachLookups: ["com.apple.system.opendirectoryd.libinfo"],
        });
      expect(result.filesystem).toEqual({
        readonlyPaths: [],
        readwritePaths: platform === "darwin" ? ["/dev"] : [],
      });
    }
  );

  it.each(["linux", "darwin"] as const)("keeps internal cleanup offline on %s", (platform) => {
    const result = config({ ...input(platform), network: "deny" });
    expect(result.network).toEqual({
      egress: { default: "deny" },
      ingress: { default: "deny", hostLoopback: "deny" },
    });
  });

  it("rejects unrepresentable inputs", () => {
    expect(() => compileMxcLaunch({ ...input(), argv: ["bad\0argument"] })).toThrow(/NUL/);
    expect(() => compileMxcLaunch({ ...input(), guestEnvironment: { "BAD=KEY": "x" } })).toThrow(
      /environment/
    );
    expect(() => compileMxcLaunch({ ...input(), launcher: "mxc" })).toThrow(
      /installed absolute path/
    );
    expect(mxcLauncherEnvironment({ TOKEN: "secret" })).toEqual({ TOKEN: "secret" });
  });
});

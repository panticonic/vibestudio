import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { compileExecution, type ExecutionPolicy } from "./index.js";
import { validateExecutionPolicy } from "./policy.js";

afterEach(() => vi.unstubAllEnvs());

function policy(): ExecutionPolicy {
  return {
    version: 1,
    owner: {
      workspaceId: "w",
      contextId: "c",
      runtimeId: "native-1",
      incarnation: "i",
      executionDigest: "sha256:code",
    },
    privateRoot: "/owned/job",
    executable: "/usr/bin/node",
    args: ["/owned/job/input/main.cjs"],
    cwd: "/owned/job/input",
    home: "/owned/job/state/home",
    environment: { LANG: "C.UTF-8" },
    read: ["/usr", "/owned/job/input"],
    write: ["/owned/job/state"],
    sockets: [],
  };
}

describe("resolved execution resource policy", () => {
  it.each(["/", "/owned/job/../sibling", "relative", "/owned/job/state\0ignored"])(
    "rejects broad or ambiguous resources: %s",
    (resource) => {
      expect(() => validateExecutionPolicy({ ...policy(), read: [resource] }, "linux")).toThrow();
    }
  );
  it("requires immutable initial code and disjoint writable state", () => {
    expect(() => validateExecutionPolicy({ ...policy(), read: ["/owned/job"] }, "linux")).toThrow();
    expect(() =>
      validateExecutionPolicy({ ...policy(), write: ["/owned/job/state", "/usr"] }, "linux")
    ).toThrow();
    expect(() => validateExecutionPolicy({ ...policy(), home: "/elsewhere" }, "linux")).toThrow();
  });
  it.each(["NODE_OPTIONS", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "HOME", "XDG_CONFIG_HOME"])(
    "rejects environment override %s",
    (key) => {
      expect(() =>
        validateExecutionPolicy({ ...policy(), environment: { [key]: "attacker" } }, "linux")
      ).toThrow();
    }
  );
  it.each(["linux", "darwin", "win32"] as const)(
    "compiles MXC policy with open networking and no guest inheritance of the owner environment on %s",
    (platform) => {
      vi.stubEnv("SystemRoot", "C:\\Windows");
      vi.stubEnv("USERPROFILE", "C:\\Users\\host-owner");
      vi.stubEnv("LOCALAPPDATA", "C:\\Users\\host-owner\\AppData\\Local");
      vi.stubEnv("MXC_DACL_STATE_DIR", "owner-selected-journal");
      let p = policy();
      if (platform === "win32") {
        const win = (v: string) => "C:" + v.replaceAll("/", "\\");
        p = {
          ...p,
          privateRoot: win(p.privateRoot),
          executable: win(p.executable),
          cwd: win(p.cwd),
          home: win(p.home),
          read: p.read.map(win),
          write: p.write.map(win),
        };
      }
      const result = compileExecution(p, {
        platform,
        launcher: platform === "win32" ? "C:\\installed\\mxc.exe" : "/installed/mxc",
      });
      const config = JSON.parse(Buffer.from(result.args[1]!, "base64").toString());
      expect(result.mechanism).toBe("mxc-process");
      expect(result.args[0]).toBe("--config-base64");
      expect(config.network).toEqual({
        defaultPolicy: "allow",
        allowLocalNetwork: true,
      });
      expect(config.filesystem.readonlyPaths).toEqual([
        ...p.read,
        ...(platform === "darwin" ? ["/dev"] : []),
      ]);
      expect(config.filesystem.readwritePaths).toEqual(p.write);
      expect(config.process.env).toContain(`HOME=${p.home}`);
      expect(result.environment["HOME"]).toBe(process.env["HOME"]);
      expect(config.process.env).not.toContain(`HOME=${process.env["HOME"]}`);
      expect(config.lifecycle).toEqual({ destroyOnExit: true, preservePolicy: false });
      expect(result.environment["MXC_DACL_STATE_DIR"]).toBe("owner-selected-journal");
      expect(
        config.process.env.some((entry: string) => entry.startsWith("MXC_DACL_STATE_DIR="))
      ).toBe(false);
      if (platform === "win32") {
        expect(config.processContainer).toEqual({
          leastPrivilege: false,
          capabilities: ["internetClient", "internetClientServer", "privateNetworkClientServer"],
        });
        expect(result.environment).toMatchObject({
          PATH: process.env["PATH"],
          SystemRoot: "C:\\Windows",
          USERPROFILE: "C:\\Users\\host-owner",
          LOCALAPPDATA: "C:\\Users\\host-owner\\AppData\\Local",
        });
        expect(config.process.env).toContain(`USERPROFILE=${p.home}`);
        expect(config.process.env).toContain(`LOCALAPPDATA=${p.home}\\data`);
        expect(config.process.env.some((entry: string) => entry.includes("host-owner"))).toBe(
          false
        );
      }
    }
  );
  it.skipIf(process.platform === "win32")(
    "round-trips literal arguments through MXC's Unix shell command contract",
    () => {
      const args = [
        "",
        "space and ' quote",
        'double " quote',
        "$(exit 99)",
        "`exit 99`",
        "line\nbreak",
        "trailing\\",
      ];
      const p = {
        ...policy(),
        executable: process.execPath,
        read: [...policy().read, process.execPath],
        args: ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", "--", ...args],
      };
      const launch = compileExecution(p, { platform: "linux", launcher: "/installed/mxc" });
      const config = JSON.parse(Buffer.from(launch.args[1]!, "base64").toString());
      expect(
        JSON.parse(
          execFileSync("/bin/sh", ["-c", config.process.commandLine], { encoding: "utf8" })
        )
      ).toEqual(args);
    }
  );
  it("rejects socket admission instead of weakening network isolation", () => {
    expect(() =>
      compileExecution(
        { ...policy(), sockets: ["/broker.sock"] },
        { platform: "linux", launcher: "/installed/mxc" }
      )
    ).toThrow("socket admission");
  });
});

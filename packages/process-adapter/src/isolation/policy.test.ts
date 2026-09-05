import { describe, expect, it } from "vitest";
import { compileExecution, type ExecutionPolicy } from "./index.js";
import { validateExecutionPolicy } from "./policy.js";

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
  it("emits a Linux launch without inherited environment, root or networking", () => {
    const result = compileExecution(policy(), { platform: "linux", launcher: "/usr/bin/bwrap" });
    expect(result.environment).toEqual({});
    expect(result.args).toContain("--unshare-all");
    expect(result.args).toContain("--clearenv");
    expect(result.args).not.toContain("--share-net");
    expect(result.args).not.toContain("--dev-bind");
    expect(result.args).not.toContain("/");
  });
  it("escapes SBPL resource text without introducing policy forms", () => {
    const p = policy();
    const resource = '/owned/job/input/quote" (allow network*) \\';
    const result = compileExecution(
      { ...p, read: [...p.read, resource] },
      { platform: "darwin", launcher: "/usr/bin/sandbox-exec" }
    );
    expect(result.args[1]).toContain('quote\\" (allow network*) \\\\"');
    expect(result.args[1]).toContain("(deny default)");
    expect(result.args[1]).not.toContain("(allow network*)\n");
    expect(result.environment["HOME"]).toBe(p.home);
    expect(result.cwd).toBe(p.cwd);
  });
  it("requires private staging on Windows and keeps policy outside guest roots", () => {
    const p: ExecutionPolicy = {
      ...policy(),
      privateRoot: "C:\\owned\\job",
      executable: "C:\\owned\\job\\runtime\\node.exe",
      args: [],
      cwd: "C:\\owned\\job\\input",
      home: "C:\\owned\\job\\state\\home",
      read: ["C:\\owned\\job\\runtime", "C:\\owned\\job\\input"],
      write: ["C:\\owned\\job\\state"],
    };
    const result = compileExecution(p, {
      platform: "win32",
      launcher: "C:\\Program Files\\Vibestudio\\isolation.exe",
    });
    expect(result.mechanism).toBe("windows-lpac-job");
    expect(result.controlFiles[0]?.path).toBe("C:\\owned\\job\\.isolation-policy.json");
    expect(() =>
      compileExecution(
        { ...p, read: [...p.read, "C:\\Users\\somebody"] },
        { platform: "win32", launcher: result.command }
      )
    ).toThrow();
    expect(() =>
      validateExecutionPolicy({ ...p, write: ["C:\\owned\\job\\state:stream"] }, "win32")
    ).toThrow();
  });
});

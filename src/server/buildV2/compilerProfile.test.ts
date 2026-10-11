import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as esbuild from "esbuild";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { profileEsbuildBuild, type EsbuildRun } from "./compilerProfile.js";
import { isVerbose, logVerbose } from "@vibestudio/dev-log";

vi.mock("@vibestudio/dev-log", () => ({
  isVerbose: vi.fn(),
  logVerbose: vi.fn(),
}));

const isVerboseMock = vi.mocked(isVerbose);
const logVerboseMock = vi.mocked(logVerbose);

describe("profileEsbuildBuild", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("adds a fallthrough observer before user plugins and reports the real build result", async () => {
    isVerboseMock.mockReturnValue(true);
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "compiler-profile-"));
    try {
      const entry = path.join(directory, "entry.js");
      await fs.writeFile(entry, 'import "./dependency.js"; console.log("ready");');
      await fs.writeFile(path.join(directory, "dependency.js"), "export const value = 1;");
      const userLoads: string[] = [];
      const result = await profileEsbuildBuild({
        absWorkingDir: directory,
        entryPoints: [entry],
        bundle: true,
        write: false,
        metafile: true,
        plugins: [
          {
            name: "test-user-plugin",
            setup(build) {
              build.onLoad({ filter: /entry\.js$/ }, (args) => {
                userLoads.push(args.path);
                return null;
              });
            },
          },
        ],
      });

      expect(result.outputFiles).toHaveLength(1);
      expect(Object.keys(result.metafile?.inputs ?? {})).toHaveLength(2);
      expect(userLoads).toEqual([entry]);
      const finished = logVerboseMock.mock.calls.find((call) => call[1] === "compile finished");
      expect(finished?.[2]).toMatchObject({
        state: "succeeded",
        entrypoints: [entry],
        cwd: directory,
        metafileInputCount: 2,
        metafileOutputCount: 1,
        loadedModules: 2,
      });
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("logs terminal failure and rethrows the exact error when the esbuild service rejects before onEnd", async () => {
    isVerboseMock.mockReturnValue(true);
    const failure = Object.assign(new Error("service exited"), { code: "SERVICE_EXIT" });
    let receivedOptions: esbuild.BuildOptions | undefined;
    const run: EsbuildRun = async <T extends esbuild.BuildOptions>(
      options: T & { [Key in Exclude<keyof T, keyof esbuild.BuildOptions>]: never }
    ) => {
      receivedOptions = options;
      throw failure;
    };

    await expect(profileEsbuildBuild({ entryPoints: ["src/index.ts"] }, run)).rejects.toBe(failure);
    expect(receivedOptions?.plugins?.[0]?.name).toBe("vibestudio-compiler-profile");
    const finished = logVerboseMock.mock.calls.find((call) => call[1] === "compile finished");
    expect(finished?.[2]).toMatchObject({ state: "failed", loadedModules: 0 });
  });

  it("passes the same options object through without diagnostic plugins when verbose logging is off", async () => {
    isVerboseMock.mockReturnValue(false);
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "compiler-profile-"));
    const entry = path.join(directory, "entry.js");
    await fs.writeFile(entry, "console.log('ready');");
    const options = { absWorkingDir: directory, entryPoints: [entry], write: false as const };
    let receivedOptions: esbuild.BuildOptions | undefined;
    const run: EsbuildRun = async <T extends esbuild.BuildOptions>(
      buildOptions: T & { [Key in Exclude<keyof T, keyof esbuild.BuildOptions>]: never }
    ) => {
      receivedOptions = buildOptions;
      return esbuild.build<T>(buildOptions);
    };

    try {
      const result = await profileEsbuildBuild(options, run);
      expect(result.outputFiles).toHaveLength(1);
      expect(receivedOptions).toBe(options);
      expect(logVerboseMock).not.toHaveBeenCalled();
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});

import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { beforeEach, expect, it, vi } from "vitest";
import { assertNativePrerequisites, formatNativeStartupError } from "./prerequisites.js";

vi.mock("node:fs/promises", () => ({ access: vi.fn() }));
vi.mock("node:child_process", () => ({
  execFile: vi.fn((_file, _args, _options, callback) => callback(null, "version", "")),
}));
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(access).mockResolvedValue(undefined);
});
const input = {
  installation: {
    platform: "linux",
    mechanism: "mxc-process",
    launcher: "/installed/mxc",
  } as const,
  environment: { PATH: "/owner/bin:/usr/bin" },
};
it("accepts Windows owner coordinates independent of environment key casing", async () => {
  await expect(
    assertNativePrerequisites({
      installation: { platform: "win32", mechanism: "host-process" },
      environment: {
        SYSTEMROOT: "C:\\Windows",
        userprofile: "C:\\owner",
        LocalAppData: "C:\\owner\\AppData\\Local",
      },
    })
  ).resolves.toBeUndefined();
});
it("reports a missing packaged executor before launching any helper", async () => {
  vi.mocked(access).mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "ENOENT" }));
  await expect(assertNativePrerequisites(input)).rejects.toThrow(/Repair the app installation/);
  expect(execFile).not.toHaveBeenCalled();
});
it("probes only relevant helpers with the same closed owner environment and bounded execution", async () => {
  await assertNativePrerequisites(input);
  expect(execFile).toHaveBeenCalledExactlyOnceWith(
    "bwrap",
    ["--version"],
    {
      env: input.environment,
      timeout: 3000,
      maxBuffer: 16384,
      windowsHide: true,
    },
    expect.any(Function)
  );
});
it("reports a missing filesystem containment helper", async () => {
  vi.mocked(execFile).mockImplementationOnce((...args: any[]) =>
    args.at(-1)(new Error("spawn bwrap ENOENT"))
  );
  await expect(assertNativePrerequisites(input)).rejects.toThrow(/Install bubblewrap/);
});
it("requires only Windows OS coordinates, without probing containment helpers", async () => {
  await expect(
    assertNativePrerequisites({
      installation: { platform: "win32", mechanism: "host-process" },
      environment: {},
    })
  ).rejects.toThrow(/SystemRoot/);
  await assertNativePrerequisites({
    installation: { platform: "win32", mechanism: "host-process" },
    environment: { SYSTEMROOT: "C:\\Windows" },
  });
  expect(execFile).not.toHaveBeenCalled();
  expect(access).not.toHaveBeenCalled();
});
it("checks Seatbelt availability without inferring it from macOS version", async () => {
  vi.mocked(access).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("missing"));
  await expect(
    assertNativePrerequisites({
      ...input,
      installation: { ...input.installation, platform: "darwin" },
    })
  ).rejects.toThrow(/sandbox-exec/);
});
it.each([
  [
    "bwrap: Can't mkdir parents for /lib/libdl.so.2: No such file or directory",
    /runtime-admission/,
  ],
  ["bwrap: Creating new namespace failed: Operation not permitted", /security policy/],
])("retains the native diagnostic and identifies its remedy", (stderr, remedy) => {
  const error = formatNativeStartupError({
    ...input,
    error: new Error("Exited before readiness"),
    stderr,
    code: 1,
  });
  expect(error.message).toContain(stderr);
  expect(error.message).toContain("exit 1");
  expect(error.message).toMatch(remedy);
});
it("bounds retained stderr", () => {
  const error = formatNativeStartupError({
    ...input,
    error: new Error("closed"),
    stderr: "x".repeat(20_000) + "last failure",
  });
  expect(error.message.length).toBeLessThan(17_000);
  expect(error.message.endsWith("last failure")).toBe(true);
});
it("reports Windows native failure without suggesting sandbox provisioning", () => {
  const error = formatNativeStartupError({
    installation: { platform: "win32", mechanism: "host-process" },
    error: new Error("closed"),
    stderr: "native failure",
  });
  expect(error.message).toContain("host-process");
  expect(error.message).toContain("no sandbox setup is required");
  expect(error.message).toContain("native failure");
});

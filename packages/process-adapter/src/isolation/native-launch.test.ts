import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import { compileNativeLaunch, type NativeLaunchInput } from "./native-launch.js";

const input: NativeLaunchInput = {
  installation: { platform: "win32", mechanism: "host-process" },
  containerId: "test",
  argv: [
    "C:\\installed runtime\\node.exe",
    "",
    "a b",
    'a"b',
    "trailing\\",
    "$(echo injected)",
    "&echo injected",
  ],
  cwd: "C:\\workspace",
  guestEnvironment: { SystemRoot: "C:\\Windows", HOME: "C:\\workspace\\home" },
  readPaths: [],
  writePaths: [],
  network: "allow",
};
it("compiles Windows directly with literal argv and only explicitly provisioned environment", () => {
  const launch = compileNativeLaunch(input, { TOKEN: "owner-secret", USERPROFILE: "C:\\owner" });
  expect(launch).toEqual({
    command: input.argv[0],
    args: input.argv.slice(1),
    cwd: input.cwd,
    environment: input.guestEnvironment,
    mechanism: "host-process",
  });
  expect(compileNativeLaunch({ ...input, network: "deny" })).toEqual(compileNativeLaunch(input));
});
it("rejects script shims and malformed direct execution coordinates", () => {
  for (const executable of ["node", "C:\\tools\\node.cmd", "C:\\tools\\node.bat"])
    expect(() => compileNativeLaunch({ ...input, argv: [executable] })).toThrow(
      /absolute executable/
    );
  expect(() => compileNativeLaunch({ ...input, argv: [input.argv[0]!, "bad\0arg"] })).toThrow(
    /NUL/
  );
  expect(() => compileNativeLaunch({ ...input, guestEnvironment: { "BAD=KEY": "x" } })).toThrow(
    /environment/
  );
});
it.runIf(process.platform === "win32")(
  "executes literal Windows argv without owner environment inheritance",
  () => {
    const args = input.argv.slice(1);
    const launch = compileNativeLaunch(
      {
        ...input,
        argv: [
          process.execPath,
          "-e",
          "process.stdout.write(JSON.stringify({args:process.argv.slice(1),secret:process.env.NATIVE_OWNER_SECRET??null}))",
          "--",
          ...args,
        ],
        cwd: process.cwd(),
      },
      { NATIVE_OWNER_SECRET: "secret" }
    );
    expect(
      JSON.parse(
        execFileSync(launch.command, launch.args, {
          cwd: launch.cwd,
          env: launch.environment,
          encoding: "utf8",
        })
      )
    ).toEqual({ args, secret: null });
  }
);

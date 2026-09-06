import { execFile } from "node:child_process";
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { assertMxcPrerequisites, compileMxcLaunch } from "@vibestudio/process-adapter/mxc";
import { prepareNativeRuntime } from "./nativeRuntimeResources.js";
import { getMxcExecutable } from "./runtimePaths.js";

const execFileAsync = promisify(execFile);
const MAX_CREDENTIAL_BYTES = 64 * 1024;
// Installed code only: the credential path is data, never an executable entry.
const READ_CREDENTIAL = `
const fs = require('node:fs');
try {
  const fd = fs.openSync(process.argv[1], fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error();
    const bytes = Buffer.alloc(65537);
    let length = 0, count;
    while (length < bytes.length && (count = fs.readSync(fd, bytes, length, bytes.length - length, null)) > 0) length += count;
    if (length > 65536) throw new Error();
    process.stdout.write(bytes.subarray(0, length));
  } finally { fs.closeSync(fd); }
} catch { process.stderr.write('Credential extraction rejected'); process.exitCode = 1; }
`;

/** Extract guest-authored bytes behind MXC before the trusted owner parses them.
 * The profile's parent and the staging sibling remain owner-only throughout. */
export async function extractClaudeCredential(input: {
  profileDir: string;
  profileIdentity: { dev: string; ino: string };
  appRoot: string;
}): Promise<Buffer> {
  const metadata = await lstat(input.profileDir, { bigint: true });
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.dev.toString() !== input.profileIdentity.dev ||
    metadata.ino.toString() !== input.profileIdentity.ino ||
    (await realpath(input.profileDir)) !== input.profileDir
  )
    throw new Error("Claude credential profile anchor was replaced");
  const runtimeRoot = await realpath(
    await mkdtemp(path.join(path.dirname(input.profileDir), ".credential-runtime-"))
  );
  try {
    const runtime = prepareNativeRuntime({ appRoot: input.appRoot, runtimeRoot });
    const platform = process.platform;
    if (platform !== "linux" && platform !== "darwin" && platform !== "win32")
      throw new Error(`Unsupported Claude credential extraction platform: ${platform}`);
    const launcher = getMxcExecutable(input.appRoot);
    const launch = compileMxcLaunch({
      platform,
      launcher,
      containerId: `vibestudio-credential-${path.basename(runtimeRoot)}`,
      argv: [
        runtime.executable,
        "-e",
        READ_CREDENTIAL,
        path.join(input.profileDir, "claude-config", ".credentials.json"),
      ],
      cwd: input.profileDir,
      guestEnvironment: {
        ...runtime.environment,
        ...(platform === "win32"
          ? {
              LOCALAPPDATA: input.profileDir,
              USERPROFILE: input.profileDir,
              APPDATA: input.profileDir,
            }
          : {}),
      },
      readPaths: [...runtime.readPaths, input.profileDir],
      writePaths: [],
      network: "deny",
    });
    await assertMxcPrerequisites({ platform, launcher, environment: launch.environment });
    try {
      const result = await execFileAsync(launch.command, launch.args, {
        cwd: launch.cwd,
        env: launch.environment,
        timeout: 10000,
        maxBuffer: MAX_CREDENTIAL_BYTES,
        encoding: "buffer",
        windowsHide: true,
      });
      return result.stdout;
    } catch {
      // Child output can contain credentials; never propagate execFile's error
      // object (which embeds stdout) into host logs or RPC error envelopes.
      throw new Error("Confined Claude credential extraction failed");
    }
  } finally {
    // This sibling is read-only to the extractor and invisible to the provider.
    await rm(runtimeRoot, { recursive: true, force: true });
  }
}

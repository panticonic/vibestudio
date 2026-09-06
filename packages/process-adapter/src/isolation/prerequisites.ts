import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { IsolationError } from "./policy.js";
import { windowsEnvironmentValue } from "./windowsEnvironment.js";

const execute = promisify(execFile);
import type { NativeInstallation } from "./native-launch.js";

/** Only installed executables and owner environment are inspected here. MXC's
 * actual launch remains the authoritative test of OS policy availability. Do
 * not infer namespace/Seatbelt support from version or sysctl lists. */
export async function assertNativePrerequisites(input: {
  installation: NativeInstallation;
  environment: Record<string, string>;
}): Promise<void> {
  const { installation } = input;
  if (installation.mechanism === "host-process") {
    const systemRoot = windowsEnvironmentValue(input.environment, "SystemRoot");
    if (!systemRoot || !path.win32.isAbsolute(systemRoot))
      throw new IsolationError(
        "Windows native execution requires an absolute SystemRoot coordinate"
      );
    return;
  }
  try {
    await access(installation.launcher, constants.X_OK);
  } catch (error) {
    throw new IsolationError(
      `Installed MXC executor is missing or not executable: ${installation.launcher}. ` +
        `Repair the app installation; for a source checkout run pnpm build. ` +
        `(${(error as NodeJS.ErrnoException).code ?? "access failed"})`
    );
  }
  if (installation.platform === "linux") {
    try {
      await execute("bwrap", ["--version"], {
        env: input.environment,
        timeout: 3_000,
        maxBuffer: 16_384,
        windowsHide: true,
      });
    } catch (error) {
      const detail = error as Error & { stderr?: string };
      throw new IsolationError(
        "MXC prerequisite bwrap is unavailable. Install bubblewrap " +
          "using your distribution's package manager and make it available on the app owner's PATH. " +
          `Native diagnostic: ${(detail.stderr || detail.message).slice(-16_384)}`
      );
    }
  } else if (installation.platform === "darwin") {
    try {
      await access("/usr/bin/sandbox-exec", constants.X_OK);
    } catch {
      throw new IsolationError(
        "MXC requires macOS Seatbelt's /usr/bin/sandbox-exec, which is unavailable on this host."
      );
    }
  }
}

/** Keep the native failure verbatim; hints explain categories, never weaken the
 * requested policy or substitute a host process. Do not include serialized
 * config/guest environment, which can contain provisioned credentials. */
export function formatNativeStartupError(input: {
  installation: NativeInstallation;
  error: Error;
  stderr: string;
  code?: number | null;
  signal?: string | null;
}): IsolationError {
  const { installation } = input;
  const diagnostic = input.stderr.slice(-16_384).trim();
  const evidence = `${input.error.message}\n${diagnostic}`;
  let remedy = "";
  if (installation.platform === "linux") {
    if (/namespace|unshare|operation not permitted/i.test(evidence)) {
      remedy =
        "The host refused sandbox namespace creation. Check the host's user-namespace and security policy for bubblewrap.";
    } else if (
      /mkdir parents|mount|bind.*(?:failed|error)|No such file or directory/i.test(evidence)
    ) {
      remedy =
        "MXC could not construct the admitted runtime filesystem. This needs an app runtime-admission or MXC compatibility fix; rebuilding alone may not resolve it.";
    }
  } else if (installation.platform === "darwin") {
    remedy = "Check the installed helper's signing and macOS execution/Seatbelt diagnostics.";
  } else {
    remedy =
      "Windows workspace commands run directly as the app's OS user. Check the installed executable and native process diagnostic; no sandbox setup is required.";
  }
  return new IsolationError(
    `Workspace runtime startup failed on ${installation.platform} (${installation.mechanism}${installation.mechanism === "mxc-process" ? `, ${installation.launcher}` : ""}` +
      `${input.code == null ? "" : `, exit ${input.code}`}${input.signal ? `, signal ${input.signal}` : ""}). ` +
      `${input.error.message}${remedy ? ` ${remedy}` : ""}` +
      `${diagnostic ? `\nNative stderr:\n${diagnostic}` : ""}`
  );
}

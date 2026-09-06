import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { IsolationError } from "./policy.js";
import { windowsEnvironmentValue } from "./windowsEnvironment.js";

const execute = promisify(execFile);
type Platform = "linux" | "darwin" | "win32";

/** Only installed executables and owner environment are inspected here. MXC's
 * actual launch remains the authoritative test of OS policy availability. Do
 * not infer namespace/Seatbelt/AppContainer support from version or sysctl lists. */
export async function assertMxcPrerequisites(input: {
  platform: Platform;
  launcher: string;
  environment: Record<string, string>;
}): Promise<void> {
  try {
    await access(input.launcher, input.platform === "win32" ? constants.F_OK : constants.X_OK);
  } catch (error) {
    throw new IsolationError(
      `Installed MXC executor is missing or not executable: ${input.launcher}. ` +
        `Repair the app installation; for a source checkout run pnpm build. ` +
        `(${(error as NodeJS.ErrnoException).code ?? "access failed"})`
    );
  }
  if (input.platform === "linux") {
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
  } else if (input.platform === "darwin") {
    try {
      await access("/usr/bin/sandbox-exec", constants.X_OK);
    } catch {
      throw new IsolationError(
        "MXC requires macOS Seatbelt's /usr/bin/sandbox-exec, which is unavailable on this host."
      );
    }
  } else {
    for (const key of ["SystemRoot", "USERPROFILE", "LOCALAPPDATA"]) {
      const value = windowsEnvironmentValue(input.environment, key);
      if (!value || !path.win32.isAbsolute(value)) {
        throw new IsolationError(
          `MXC requires the host owner's absolute ${key} environment coordinate for Windows execution and ACL cleanup. ` +
            "Start the app in a normal Windows user session."
        );
      }
    }
  }
}

/** Keep the native failure verbatim; hints explain categories, never weaken the
 * requested policy or substitute a host process. Do not include serialized
 * config/guest environment, which can contain provisioned credentials. */
export function formatMxcStartupError(input: {
  platform: Platform;
  launcher: string;
  error: Error;
  stderr: string;
  code?: number | null;
  signal?: string | null;
}): IsolationError {
  const diagnostic = input.stderr.slice(-16_384).trim();
  const evidence = `${input.error.message}\n${diagnostic}`;
  let remedy = "";
  if (input.platform === "linux") {
    if (/namespace|unshare|operation not permitted/i.test(evidence)) {
      remedy =
        "The host refused sandbox namespace creation. Check the host's user-namespace and security policy for bubblewrap.";
    } else if (
      /mkdir parents|mount|bind.*(?:failed|error)|No such file or directory/i.test(evidence)
    ) {
      remedy =
        "MXC could not construct the admitted runtime filesystem. This needs an app runtime-admission or MXC compatibility fix; rebuilding alone may not resolve it.";
    }
  } else if (input.platform === "darwin") {
    remedy = "Check the installed helper's signing and macOS execution/Seatbelt diagnostics.";
  } else {
    const drive = /(?:EPERM|EACCES)[^\n]*(?:lstat|stat) ['"]([A-Za-z]:\\+)['"]/u.exec(
      evidence
    )?.[1];
    const helper = path.win32.join(path.win32.dirname(input.launcher), "wxc-host-prep.exe");
    if (drive) {
      remedy =
        `Windows sandbox drive metadata preparation is missing. With administrator approval, run "${helper}" prepare-system-drive --target ${drive.slice(0, 2)}\\. ` +
        "This stock MXC prerequisite permits drive-root metadata only, without listing or reading drive contents. Re-run the installer to prepare the system and installation drives.";
    } else if (
      /prepare-null-device|(?:access|denied|open).*?(?:\\Device\\Null|\bNUL\b)/iu.test(evidence)
    ) {
      remedy =
        `Windows sandbox NUL-device preparation is missing. With administrator approval, run "${helper}" prepare-null-device. ` +
        "Windows resets this device policy at reboot, so this preparation may need to be repeated.";
    } else {
      remedy = `Check the Windows ProcessContainer/ACL diagnostic below. Re-run the installer or use "${helper}" with administrator approval if MXC reports missing host preparation.`;
    }
  }
  return new IsolationError(
    `MXC workspace startup failed on ${input.platform} (${input.launcher}` +
      `${input.code == null ? "" : `, exit ${input.code}`}${input.signal ? `, signal ${input.signal}` : ""}). ` +
      `${input.error.message}${remedy ? ` ${remedy}` : ""}` +
      `${diagnostic ? `\nNative stderr:\n${diagnostic}` : ""}`
  );
}

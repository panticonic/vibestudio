import fs from "node:fs/promises";
import path from "node:path";
import plist from "plist";

/** Resolve the executable declared by a macOS application bundle. */
export async function resolveMacAppExecutable(appPath) {
  const bundle = path.resolve(appPath);
  const infoPath = path.join(bundle, "Contents", "Info.plist");
  const info = plist.parse(await fs.readFile(infoPath, "utf8"));
  const executableName = info.CFBundleExecutable;
  if (
    typeof executableName !== "string" ||
    executableName.length === 0 ||
    path.basename(executableName) !== executableName
  ) {
    throw new Error(`Invalid CFBundleExecutable in ${infoPath}`);
  }
  const executable = path.join(bundle, "Contents", "MacOS", executableName);
  let stat;
  try {
    stat = await fs.stat(executable);
  } catch (cause) {
    throw new Error(`Cannot read CFBundleExecutable file: ${executable}`, { cause });
  }
  if (!stat.isFile()) throw new Error(`CFBundleExecutable is not a file: ${executable}`);
  return executable;
}

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";

/** Build installed storage cleanup and Windows admission with a locked closure. */
export function buildNativeIsolation(appRoot = process.cwd()) {
  const executable =
    process.platform === "win32" ? "vibestudio-isolation.exe" : "vibestudio-isolation";
  execFileSync(
    "cargo",
    [
      "build",
      "--release",
      "--locked",
      "--manifest-path",
      path.join(appRoot, "native/isolation/Cargo.toml"),
    ],
    {
      cwd: appRoot,
      stdio: "inherit",
    }
  );
  mkdirSync(path.join(appRoot, "dist"), { recursive: true });
  copyFileSync(
    path.join(appRoot, "native/isolation/target/release", executable),
    path.join(appRoot, "dist", executable)
  );
}

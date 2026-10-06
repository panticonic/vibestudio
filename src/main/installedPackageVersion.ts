import { spawn } from "node:child_process";

/** Query the package database after upgrading, rather than trusting exit zero. */
export function installedPackageVersion(
  owner: "deb" | "rpm" | "pacman" | "brew",
  brew = "/opt/homebrew/bin/brew"
): Promise<string | null> {
  const queries = {
    deb: ["dpkg-query", "-W", "-f=${Version}", "vibestudio"],
    rpm: ["rpm", "-q", "--qf", "%{VERSION}", "vibestudio"],
    pacman: ["pacman", "-Q", "vibestudio"],
    brew: [brew, "list", "--versions", "--cask", "vibestudio"],
  };
  const [command, ...args] = queries[owner];
  if (!command) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let errorOutput = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      errorOutput += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `Could not query the installed Vibestudio package: ${errorOutput.trim() || `exit ${code}`}`
          )
        );
        return;
      }
      const version = output.trim().replace(/^vibestudio\s+/u, "");
      resolve(version || null);
    });
  });
}

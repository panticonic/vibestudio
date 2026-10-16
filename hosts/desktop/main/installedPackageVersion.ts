import type { LinuxPackageOwner } from "./linuxPackageOwner.js";
import { spawn } from "node:child_process";

/** Query the package database after upgrading, rather than trusting exit zero. */
export function installedPackageVersion(
  owner:
    | LinuxPackageOwner
    | {
        manager: "brew";
        name: string;
        executable: string;
      }
): Promise<string | null> {
  const queries = {
    deb: ["dpkg-query", "-W", "-f=${Version}", owner.name],
    rpm: ["rpm", "-q", "--qf", "%{VERSION}", owner.name],
    pacman: ["pacman", "-Q", owner.name],
    brew: [
      owner.manager === "brew" ? owner.executable : "",
      "list",
      "--versions",
      "--cask",
      owner.name,
    ],
  };
  const [command, ...args] = queries[owner.manager];
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
      const value = output.trim();
      const prefix = `${owner.name} `;
      const version = value.startsWith(prefix) ? value.slice(prefix.length).trim() : value;
      resolve(version || null);
    });
  });
}

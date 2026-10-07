import { spawnSync } from "node:child_process";

export interface LinuxPackageOwner {
  manager: "deb" | "rpm" | "pacman";
  name: string;
}

/** The database that owns the executable also supplies its exact package identity. */
export function detectLinuxPackageOwner(executable: string): LinuxPackageOwner | null {
  if (process.platform !== "linux") return null;
  const probes = [
    { manager: "deb", command: "dpkg-query", args: ["-S", executable] },
    { manager: "rpm", command: "rpm", args: ["-qf", "--qf", "%{NAME}", executable] },
    { manager: "pacman", command: "pacman", args: ["-Qoq", executable] },
  ] as const;
  for (const probe of probes) {
    try {
      const result = spawnSync(probe.command, [...probe.args], {
        timeout: 5_000,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      if (result.status !== 0) continue;
      const output = result.stdout.trim();
      const name = probe.manager === "deb" ? output.split(": ")[0] : output;
      if (name && !name.includes("\n")) return { manager: probe.manager, name };
    } catch {
      // Missing package tools cannot own this executable.
    }
  }
  return null;
}

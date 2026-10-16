import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { InstalledLauncher } from "./launcherArtifacts.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInstalled(value: unknown): value is InstalledLauncher {
  return (
    isRecord(value) &&
    typeof value["clientId"] === "string" &&
    (value["platform"] === "linux" ||
      value["platform"] === "win32" ||
      value["platform"] === "darwin") &&
    typeof value["fingerprint"] === "string" &&
    Array.isArray(value["paths"]) &&
    value["paths"].every((entry) => typeof entry === "string")
  );
}

/**
 * Every launcher this host wrote into the OS, so it can remove exactly those
 * when a client is retired or the person removes one. Per device, atomic.
 */
export class InstalledLaunchers {
  private launchers = new Map<string, InstalledLauncher>();

  constructor(private readonly file: string) {
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !Array.isArray(parsed["launchers"])) {
      throw new Error(`Installed launcher record is malformed: ${file}`);
    }
    for (const entry of parsed["launchers"]) {
      if (isInstalled(entry)) this.launchers.set(entry.clientId, entry);
    }
  }

  list(): InstalledLauncher[] {
    return [...this.launchers.values()];
  }

  get(clientId: string): InstalledLauncher | undefined {
    return this.launchers.get(clientId);
  }

  set(launcher: InstalledLauncher): void {
    this.launchers.set(launcher.clientId, launcher);
    this.save();
  }

  delete(clientId: string): void {
    if (this.launchers.delete(clientId)) this.save();
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const scratch = `${this.file}.${randomUUID()}.tmp`;
    fs.writeFileSync(scratch, JSON.stringify({ launchers: this.list() }, null, 2), { mode: 0o600 });
    fs.renameSync(scratch, this.file);
  }
}

import type { ClientLaunchEntries } from "@vibestudio/client-host-core";
import type { InstalledLaunchers } from "./installedLaunchers.js";
import {
  type InstalledLauncher,
  installLauncher,
  launcherFingerprint,
  removeLauncher,
  type LauncherEnvironment,
  type LauncherSpec,
} from "./launcherArtifacts.js";

export interface LauncherServiceDeps {
  env: LauncherEnvironment;
  records: InstalledLaunchers;
  /** The clients this host can run, as the latest integration snapshot lists them. */
  clients(): readonly ClientLaunchEntries[];
  /** The host's own confirmation, shown before it writes into the OS. False when declined. */
  confirm(title: string): Promise<boolean>;
}

/**
 * Installing and removing client launchers (`integration.install`), and keeping
 * them in step with the workspace. Installing is person-initiated and
 * host-confirmed; reconciling runs on the server's `clients:changed` event, never
 * on a timer: a launcher is rewritten when what it presents changed, and removed
 * when its client is no longer one this host can run.
 */
export class LauncherService {
  private readonly listeners = new Set<() => void>();

  constructor(private readonly deps: LauncherServiceDeps) {}

  installed(): string[] {
    return this.deps.records.list().map((launcher) => launcher.clientId);
  }

  /** Every launcher this host wrote, with the OS paths it owns. */
  records(): InstalledLauncher[] {
    return this.deps.records.list();
  }

  /** Called after a launcher was written or removed. */
  onChanged(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(): void {
    for (const listener of [...this.listeners]) listener();
  }

  private specOf(clientId: string): LauncherSpec {
    const client = this.deps.clients().find((candidate) => candidate.clientId === clientId);
    if (!client) throw new Error(`${clientId} is not a client this host can run`);
    return { clientId, title: client.title, entries: client.entries };
  }

  /** Returns false when the person declined; throws when the launcher cannot be written. */
  async install(clientId: string): Promise<boolean> {
    const spec = this.specOf(clientId);
    if (!(await this.deps.confirm(spec.title))) return false;
    await this.write(spec);
    return true;
  }

  async remove(clientId: string): Promise<void> {
    const launcher = this.deps.records.get(clientId);
    if (!launcher) return;
    await removeLauncher(launcher, this.deps.env.fs);
    this.deps.records.delete(clientId);
    this.changed();
  }

  /**
   * Bring every recorded launcher in step with the clients this host can run.
   * Every launcher is attempted; the failures are reported together.
   */
  async reconcile(): Promise<void> {
    const failures: unknown[] = [];
    const known = new Set(this.deps.clients().map((client) => client.clientId));
    for (const launcher of this.deps.records.list()) {
      try {
        if (!known.has(launcher.clientId)) {
          await this.remove(launcher.clientId);
          continue;
        }
        const spec = this.specOf(launcher.clientId);
        if (launcherFingerprint(spec) !== launcher.fingerprint) await this.write(spec);
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Launcher reconcile failed");
  }

  private async write(spec: LauncherSpec): Promise<void> {
    const previous = this.deps.records.get(spec.clientId);
    // A launcher whose title changed lives at another path: remove what it left first.
    if (previous) {
      await removeLauncher(previous, this.deps.env.fs);
      this.deps.records.delete(spec.clientId);
    }
    this.deps.records.set(await installLauncher(spec, this.deps.env));
    this.changed();
  }
}

import type { InstalledLauncher } from "@vibestudio/rn-client-api/integrationProtocol";
import type { KeyValueStore } from "./ports";

const DEVELOPMENT = "vibestudio:host:development:";
const LAUNCHER = "vibestudio:host:launcher:";
const CLIENT_STATE = "vibestudio:host:client-state:";

/**
 * What the host remembers per client on this device: its development mode
 * (§7.4: a rebuilt client is adopted at once instead of asking), the launchers
 * the OS confirmed (so they can be disabled when the client is retired) and the
 * client-scoped state a client keeps through `api.state`. Namespaces are
 * derived from the client id, never from anything a client sends, so one
 * client cannot read or write another's.
 */
export class HostState {
  private readonly development = new Set<string>();
  private readonly launcherRecords = new Map<string, InstalledLauncher>();

  constructor(private readonly store: KeyValueStore) {}

  /** Load the clients in development mode; call once at start. */
  async load(): Promise<void> {
    for (const key of await this.store.keys(DEVELOPMENT)) {
      this.development.add(key.slice(DEVELOPMENT.length));
    }
    for (const key of await this.store.keys(LAUNCHER)) {
      const raw = await this.store.get(key);
      if (raw === null) continue;
      const launcher = JSON.parse(raw) as InstalledLauncher;
      this.launcherRecords.set(launcher.launcherId, launcher);
    }
  }

  /** Launchers the host wrote and the OS confirmed. */
  launchers(): InstalledLauncher[] {
    return [...this.launcherRecords.values()];
  }

  async recordLauncher(launcher: InstalledLauncher): Promise<void> {
    await this.store.set(LAUNCHER + launcher.launcherId, JSON.stringify(launcher));
    this.launcherRecords.set(launcher.launcherId, launcher);
  }

  async forgetLauncher(launcherId: string): Promise<void> {
    await this.store.remove(LAUNCHER + launcherId);
    this.launcherRecords.delete(launcherId);
  }

  isDevelopment(clientId: string): boolean {
    return this.development.has(clientId);
  }

  async setDevelopment(clientId: string, enabled: boolean): Promise<void> {
    if (enabled) {
      await this.store.set(DEVELOPMENT + clientId, "1");
      this.development.add(clientId);
    } else {
      await this.store.remove(DEVELOPMENT + clientId);
      this.development.delete(clientId);
    }
  }

  clientState(clientId: string) {
    const prefix = `${CLIENT_STATE}${clientId}:`;
    return {
      get: (key: string) => this.store.get(prefix + key),
      set: (key: string, value: string) => this.store.set(prefix + key, value),
      remove: (key: string) => this.store.remove(prefix + key),
      keys: async () => (await this.store.keys(prefix)).map((key) => key.slice(prefix.length)),
    };
  }
}

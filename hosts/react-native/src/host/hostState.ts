import type { KeyValueStore } from "./ports";

const DEVELOPMENT = "vibestudio:host:development:";
const CLIENT_STATE = "vibestudio:host:client-state:";

/**
 * What the host remembers per client on this device: its development mode
 * (§7.4: a rebuilt client is adopted at once instead of asking) and the
 * client-scoped state a client keeps through `api.state`. Namespaces are
 * derived from the client id, never from anything a client sends, so one
 * client cannot read or write another's.
 */
export class HostState {
  private readonly development = new Set<string>();

  constructor(private readonly store: KeyValueStore) {}

  /** Load the clients in development mode; call once at start. */
  async load(): Promise<void> {
    for (const key of await this.store.keys(DEVELOPMENT)) {
      this.development.add(key.slice(DEVELOPMENT.length));
    }
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

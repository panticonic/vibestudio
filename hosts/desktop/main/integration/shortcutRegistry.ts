import { ACCELERATOR } from "../clientMenu.js";

/** The subset of Electron's `globalShortcut` this registry uses. */
export interface GlobalShortcutPort {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}

/** What a client asked a system-wide shortcut to do. */
export interface ShortcutRequest {
  /** The client's own name for it; registering the same id again replaces it. */
  id: string;
  accelerator: string;
  intent: string;
  params?: Record<string, string>;
}

interface Registration extends ShortcutRequest {
  clientId: string;
}

export interface ShortcutRegistryDeps {
  shortcuts: GlobalShortcutPort;
  /**
   * Whether the client declares this intent, and the registration is meaningful
   * for it. Throws a message fit to show the client when it is not.
   */
  validate(clientId: string, request: ShortcutRequest): void;
  /** The shortcut was pressed. */
  run(clientId: string, request: ShortcutRequest): void;
}

/**
 * System-wide keyboard shortcuts clients registered (`global-shortcut`).
 *
 * A registration lives exactly as long as the grant and the client that made it:
 * the host unregisters a client's shortcuts when it stops, is retired, loses the
 * capability, or disappears from the workspace. A system-wide chord must carry
 * a modifier, because one without would take that key from every application.
 */
export class ShortcutRegistry {
  private readonly registrations = new Map<string, Registration>();

  constructor(private readonly deps: ShortcutRegistryDeps) {}

  private key(clientId: string, id: string): string {
    return `${clientId}\u0000${id}`;
  }

  register(clientId: string, request: ShortcutRequest): void {
    if (!ACCELERATOR.test(request.accelerator) || !request.accelerator.includes("+")) {
      throw new Error(
        `"${request.accelerator}" is not a system-wide shortcut: it needs a modifier`
      );
    }
    this.deps.validate(clientId, request);
    const key = this.key(clientId, request.id);
    const mine = this.registrations.get(key);
    for (const other of this.registrations.values()) {
      if (other.accelerator.toLowerCase() === request.accelerator.toLowerCase() && other !== mine) {
        throw new Error(`${request.accelerator} is already registered by ${other.clientId}`);
      }
    }
    const registration: Registration = { ...request, clientId };
    // Release the old chord first: replacing a registration with the same chord must not conflict with itself.
    if (mine) this.deps.shortcuts.unregister(mine.accelerator);
    const registered = this.deps.shortcuts.register(request.accelerator, () =>
      this.deps.run(clientId, request)
    );
    if (!registered) {
      this.registrations.delete(key);
      throw new Error(`${request.accelerator} is held by another application`);
    }
    this.registrations.set(key, registration);
  }

  unregister(clientId: string, id: string): void {
    const key = this.key(clientId, id);
    const registration = this.registrations.get(key);
    if (!registration) return;
    this.deps.shortcuts.unregister(registration.accelerator);
    this.registrations.delete(key);
  }

  /** The client stopped, was retired, or lost the capability. */
  unregisterClient(clientId: string): void {
    for (const registration of [...this.registrations.values()]) {
      if (registration.clientId === clientId) this.unregister(clientId, registration.id);
    }
  }

  /**
   * Keep only registrations whose intent the client still declares. A client
   * that is gone, or whose intent was withdrawn, loses the shortcut.
   */
  revalidate(): void {
    for (const registration of [...this.registrations.values()]) {
      try {
        this.deps.validate(registration.clientId, registration);
      } catch {
        this.unregister(registration.clientId, registration.id);
      }
    }
  }

  list(clientId: string): ShortcutRequest[] {
    return [...this.registrations.values()]
      .filter((registration) => registration.clientId === clientId)
      .map(({ clientId: _client, ...request }) => request);
  }
}

import type { BaseWindow, WebContents } from "electron";
import type { ClientCapability } from "@vibestudio/workspace-contracts/clients";
import type { CapabilityScope } from "@vibestudio/rpc";

/**
 * Client windows (docs/client-hosts-and-clients-plan.md §5.1).
 *
 * A client runs in one or more windows; every window belongs to exactly one
 * client. This module owns that relation, independent of Electron: which
 * windows a client has, which client a renderer belongs to, and how a window
 * leaves its client. Windows are created by a factory (a plain window, or the
 * window of the one panel-hosting client), so the registry can be exercised
 * without a display.
 */

/** The sealed code identity of the exact client build a window runs. */
export interface ClientCodeIdentity {
  source: string;
  effectiveVersion: string;
  executionDigest: string;
  /** The reviewed capability requests sealed into the build. */
  requested: readonly CapabilityScope[];
}

/** What one client window runs: the build, who it acts as, and what it may do. */
export interface ClientWindowSpec {
  clientId: string;
  /** `client:<id>:web:<deviceId>`, the principal every session of this client acts as. */
  principalId: string;
  title: string;
  source: string;
  buildKey: string;
  /** The verified entry page, `vs-client://<clientId>/<buildKey>/<page>.html`. */
  entryUrl: string;
  /** Capabilities the server granted this build. */
  capabilities: readonly ClientCapability[];
  codeIdentity: ClientCodeIdentity;
  /** Workspace the client principal is registered in (the System workspace). */
  workspaceId: string;
  /** A small window for one quick interaction (a global shortcut's intent), beside the client's own. */
  compact?: boolean;
}

export interface ClientWindow {
  /** Unique across windows; the key of this window's contributed menu. */
  readonly windowId: string;
  /** The id IPC resolves this window's renderer to (`ctx.caller.runtime.id` in local services). */
  readonly callerId: string;
  readonly spec: ClientWindowSpec;
  /** Whether this window hosts the panel surface (at most one such window exists). */
  readonly hostsPanels: boolean;
  contents(): WebContents | null;
  browserWindow(): BaseWindow | null;
  show(): void;
  /** Move this window to another build of its client. */
  swap(next: ClientWindowSpec): Promise<void>;
  /** The server granted this client's running build a different capability set. */
  setCapabilities(capabilities: readonly ClientCapability[]): void;
  /** Deliver one message to the window's renderer. */
  send(channel: string, ...args: unknown[]): void;
  close(): void;
}

export interface ClientWindowFactory {
  /** A window of a client that does not host panels. */
  plain(windowId: string, spec: ClientWindowSpec): Promise<ClientWindow>;
  /** The window of the panel-hosting client. */
  panelHosting(windowId: string, spec: ClientWindowSpec): Promise<ClientWindow>;
}

export interface ClientWindowEvents {
  /**
   * A window exists. The host acquires what a running client's window holds
   * for its whole life; a failure fails the open.
   */
  opened(window: ClientWindow): Promise<void>;
  /** A window ended, by the person closing it or by the host closing it. */
  closed(window: ClientWindow, reason: string | null): void;
}

export class ClientWindows {
  private readonly windows = new Map<string, ClientWindow>();
  private readonly byCallerId = new Map<string, ClientWindow>();
  private readonly closing = new Map<string, string | null>();
  private nextWindow = 0;

  constructor(
    private readonly factory: ClientWindowFactory,
    private readonly events: ClientWindowEvents
  ) {}

  /**
   * Open one more window of a client. The client that hosts panels has exactly
   * one window: the panel surface can be presented in one place only, so
   * opening it again focuses the window it has.
   */
  async open(spec: ClientWindowSpec): Promise<ClientWindow> {
    const hostsPanels = spec.capabilities.includes("panel-hosting");
    if (hostsPanels) {
      const existing = this.windowsOf(spec.clientId)[0];
      if (existing) {
        existing.show();
        return existing;
      }
    }
    const windowId = `window:${spec.clientId}:${++this.nextWindow}`;
    const window = hostsPanels
      ? await this.factory.panelHosting(windowId, spec)
      : await this.factory.plain(windowId, spec);
    this.windows.set(window.windowId, window);
    this.byCallerId.set(window.callerId, window);
    await this.events.opened(window);
    return window;
  }

  windowsOf(clientId: string): ClientWindow[] {
    return [...this.windows.values()].filter((window) => window.spec.clientId === clientId);
  }

  /** The window whose renderer is `callerId`, or null. */
  byCaller(callerId: string): ClientWindow | null {
    return this.byCallerId.get(callerId) ?? null;
  }

  byWebContents(webContentsId: number): ClientWindow | null {
    for (const window of this.windows.values()) {
      const contents = window.contents();
      if (contents && !contents.isDestroyed() && contents.id === webContentsId) return window;
    }
    return null;
  }

  /** The window that hosts the panel surface, if its client is running. */
  panelHost(): ClientWindow | null {
    return [...this.windows.values()].find((window) => window.hostsPanels) ?? null;
  }

  all(): ClientWindow[] {
    return [...this.windows.values()];
  }

  /** Focus a client's most recent window; false when it has none. */
  focus(clientId: string): boolean {
    const window = this.windowsOf(clientId).at(-1);
    if (!window) return false;
    window.show();
    return true;
  }

  /**
   * The host ends a window. The reason is recorded first so the close the
   * window then reports is attributed to the host, not to the person.
   */
  close(window: ClientWindow, reason: string): void {
    if (!this.windows.has(window.windowId)) return;
    this.closing.set(window.windowId, reason);
    window.close();
  }

  /** Close every window of a client, for a reason the person is told. */
  closeClient(clientId: string, reason: string): ClientWindow[] {
    const closed = this.windowsOf(clientId);
    for (const window of closed) this.close(window, reason);
    return closed;
  }

  /** A window reports that it ended (the person closed it, or the host did). */
  notifyClosed(window: ClientWindow): void {
    if (this.windows.get(window.windowId) !== window) return;
    this.windows.delete(window.windowId);
    this.byCallerId.delete(window.callerId);
    const reason = this.closing.get(window.windowId) ?? null;
    this.closing.delete(window.windowId);
    this.events.closed(window, reason);
  }
}

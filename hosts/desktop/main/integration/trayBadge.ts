import type { ClientTrayModel } from "../clientMenu.js";

/** The subset of Electron's `Tray` a client's tray icon uses. */
export interface TrayLike {
  setToolTip(tooltip: string): void;
  setContextMenu(menu: unknown): void;
  on(event: "click", listener: () => void): unknown;
  destroy(): void;
}

export interface ClientTraysDeps {
  /** A tray icon for the client; the host's icon, so every client's entry reads as Vibestudio's. */
  createTray(clientId: string): TrayLike;
  /** The native menu of a tray model; a choice is reported through `dispatch`. */
  buildMenu(model: ClientTrayModel, dispatch: (actionId: string) => void): unknown;
  /** The icon was clicked: bring the client forward. */
  activate(clientId: string): void;
  /** A menu entry was chosen: relay its action id to the client. */
  action(clientId: string, actionId: string): void;
}

/**
 * Each client's system-tray entry (`tray`): one icon per client, shown while the
 * client holds the capability and runs. The client describes the menu as data;
 * the host builds it and relays a choice back as an action id.
 */
export class ClientTrays {
  private readonly trays = new Map<string, TrayLike>();

  constructor(private readonly deps: ClientTraysDeps) {}

  set(clientId: string, model: ClientTrayModel): void {
    let tray = this.trays.get(clientId);
    if (!tray) {
      tray = this.deps.createTray(clientId);
      tray.on("click", () => this.deps.activate(clientId));
      this.trays.set(clientId, tray);
    }
    tray.setToolTip(model.tooltip ?? "");
    tray.setContextMenu(
      this.deps.buildMenu(model, (actionId) => this.deps.action(clientId, actionId))
    );
  }

  /** The client withdrew its entry, stopped, was retired, or lost the capability. */
  clear(clientId: string): void {
    const tray = this.trays.get(clientId);
    if (!tray) return;
    this.trays.delete(clientId);
    tray.destroy();
  }

  has(clientId: string): boolean {
    return this.trays.has(clientId);
  }
}

export interface BadgePort {
  setBadgeCount(count: number): boolean;
}

/** The largest count a contributor may show; the OS truncates what it cannot draw. */
export const MAX_BADGE_COUNT = 99_999;

/**
 * The application icon's badge: the only writer of the OS badge count. There
 * is one icon, so its count is the sum of what each contributor reports —
 * each running client with `badge` (by client id), and the host's own
 * contributions (pending approvals, a request for attention). A contributor
 * changes or withdraws only its own part; none can erase another's.
 */
export class AppBadge {
  private readonly counts = new Map<string, number>();

  constructor(private readonly app: BadgePort) {}

  set(contributor: string, count: unknown): void {
    if (!Number.isInteger(count) || (count as number) < 0 || (count as number) > MAX_BADGE_COUNT) {
      throw new Error(`A badge count is a whole number from 0 to ${MAX_BADGE_COUNT}`);
    }
    if (count === 0) this.counts.delete(contributor);
    else this.counts.set(contributor, count as number);
    this.apply();
  }

  clear(contributor: string): void {
    if (this.counts.delete(contributor)) this.apply();
  }

  total(): number {
    let sum = 0;
    for (const count of this.counts.values()) sum += count;
    return sum;
  }

  private apply(): void {
    try {
      this.app.setBadgeCount(this.total());
    } catch {
      // The platform or desktop environment draws no badge; the counts stay.
    }
  }
}

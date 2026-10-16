import {
  launchEntries,
  textParamOf,
  type ClientLaunchEntries,
  type SnapshotClient,
} from "@vibestudio/client-host-core";
import { clientIntents, type ClientIntentDecl } from "@vibestudio/workspace-contracts/clients";
import type { LauncherService } from "./launcherService.js";
import type { ShortcutRegistry, ShortcutRequest } from "./shortcutRegistry.js";

/** The host UI that asks for a background intent's input and shows its text result. */
export interface AskPort {
  open(ask: {
    clientId: string;
    title: string;
    /** Run the intent with what the person typed; resolves with its text result. */
    submit(text: string): Promise<string>;
  }): void;
}

export interface ClientIntegrationDeps {
  /** `clients.integrationSnapshot` for this host. */
  fetchSnapshot(): Promise<{ clients: readonly SnapshotClient[] }>;
  launchers: LauncherService;
  shortcuts(): ShortcutRegistry;
  /** Put the OS-level menus (Dock menu, jump list) in step with the clients. */
  applySurfaces(clients: readonly ClientLaunchEntries[]): void;
  /** Launch a client's foreground intent in a compact window of the client. */
  openForeground(clientId: string, intent: { name: string; params: Record<string, string> }): void;
  /** Run a background intent server-side; resolves with its text. */
  invokeBackground(request: {
    id: string;
    intent: string;
    params: Record<string, string>;
  }): Promise<string>;
  ask: AskPort;
}

/**
 * What the workspace says can be launched, and everything the host projects it
 * onto: launchers, the Dock menu or jump list, global shortcuts.
 *
 * The snapshot is refreshed when the server announces `clients:changed` and when
 * a client launches, never on a timer; refreshes run one at a time so the
 * latest snapshot is always the one applied.
 */
export class ClientIntegration {
  private clients: readonly SnapshotClient[] = [];
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: ClientIntegrationDeps) {}

  /** The clients this host can run, with their launch entries. */
  entries(): ClientLaunchEntries[] {
    return launchEntries(this.clients);
  }

  /** The latest snapshot's declaration of an intent. */
  intentOf(clientId: string, name: string): ClientIntentDecl | undefined {
    const client = this.clients.find((candidate) => candidate.id === clientId);
    return client && clientIntents({ intents: [...client.intents] }).find((i) => i.name === name);
  }

  /** Fetch the snapshot and apply it everywhere. Rejects with every failed projection. */
  refresh(): Promise<void> {
    const run = this.tail.then(() => this.apply());
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async apply(): Promise<void> {
    this.clients = (await this.deps.fetchSnapshot()).clients;
    const failures: unknown[] = [];
    const attempt = async (work: () => unknown): Promise<void> => {
      try {
        await work();
      } catch (error) {
        failures.push(error);
      }
    };
    await attempt(() => this.deps.launchers.reconcile());
    await attempt(() => this.deps.shortcuts().revalidate());
    await attempt(() => this.deps.applySurfaces(this.entries()));
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "Integration refresh failed");
  }

  /** Whether a client may register `request`: it declares the intent, and the host can run it. */
  validateShortcut(clientId: string, request: ShortcutRequest): void {
    const intent = this.intentOf(clientId, request.intent);
    if (!intent) throw new Error(`${clientId} declares no intent ${request.intent}`);
    if (intent.kind === "background" && textParamOf(intent) === null) {
      throw new Error(`${clientId}/${intent.name} takes no text, so there is nothing to ask for`);
    }
  }

  /** A client's shortcut was pressed. */
  runShortcut(clientId: string, request: ShortcutRequest): void {
    const intent = this.intentOf(clientId, request.intent);
    if (!intent) throw new Error(`${clientId} declares no intent ${request.intent}`);
    const params = request.params ?? {};
    if (intent.kind === "foreground") {
      this.deps.openForeground(clientId, { name: intent.name, params });
      return;
    }
    const textParam = textParamOf(intent);
    if (textParam === null) throw new Error(`${clientId}/${intent.name} takes no text`);
    const title = this.clients.find((client) => client.id === clientId)?.title ?? clientId;
    this.deps.ask.open({
      clientId,
      title: intent.title ?? title,
      submit: (text) =>
        this.deps.invokeBackground({
          id: clientId,
          intent: intent.name,
          params: { ...params, [textParam]: text },
        }),
    });
  }
}

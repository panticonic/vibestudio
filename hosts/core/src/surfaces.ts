import { clientIntents, type ClientIntentDecl } from "@vibestudio/workspace-contracts/clients";

/**
 * How a client's declared intents become launch surfaces (docs/client-hosts-and-clients-plan.md
 * §4.7). Generic: it reads declarations, never a client by name. Plain functions over
 * `clients.integrationSnapshot` so each host's platform half stays thin.
 */

/** `vibestudio://c/<id>/<intent>?<params>`, the link the OS hands back when the surface is used. */
export function clientIntentLink(
  id: string,
  intent: string,
  params: Readonly<Record<string, string>> = {}
): string {
  const query = Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
  return `vibestudio://c/${encodeURIComponent(id)}/${encodeURIComponent(intent)}${query ? `?${query}` : ""}`;
}

/** The parameter an intent takes free text in: its first `text` parameter. */
export function textParamOf(intent: Pick<ClientIntentDecl, "params">): string | null {
  for (const [name, type] of Object.entries(intent.params ?? {})) if (type === "text") return name;
  return null;
}

/** One client of `clients.integrationSnapshot`. */
export interface SnapshotClient {
  id: string;
  title: string;
  intents: readonly ClientIntentDecl[];
  entries: Readonly<
    Record<string, ReadonlyArray<{ title: string; params: Readonly<Record<string, string>> }>>
  >;
}

/** One launchable item of a client: a menu entry, a jump-list task, a launcher action. */
export interface LaunchEntry {
  clientId: string;
  /** The intent it runs; `open` is the client itself. */
  intent: string;
  label: string;
  link: string;
}

export interface ClientLaunchEntries {
  clientId: string;
  title: string;
  /** The client's `open` entry, then its other plain intents, then dynamic entries. */
  entries: LaunchEntry[];
}

/**
 * What can be launched without further input: a client's foreground intents
 * that take no parameters (and accept no shared item), and each dynamic entry
 * of a parameterized foreground intent. Background intents and intents that
 * need input the person has not given are not launch entries.
 */
export function launchEntries(clients: readonly SnapshotClient[]): ClientLaunchEntries[] {
  return clients.map((client) => ({
    clientId: client.id,
    title: client.title,
    entries: clientIntents({ intents: [...client.intents] }).flatMap((intent): LaunchEntry[] => {
      if (intent.kind !== "foreground" || intent.accepts !== undefined) return [];
      if (Object.keys(intent.params ?? {}).length === 0) {
        return [
          {
            clientId: client.id,
            intent: intent.name,
            label: intent.name === "open" ? client.title : (intent.title ?? intent.name),
            link: clientIntentLink(client.id, intent.name),
          },
        ];
      }
      return (client.entries[intent.name] ?? []).map((entry) => ({
        clientId: client.id,
        intent: intent.name,
        label: entry.title,
        link: clientIntentLink(client.id, intent.name, entry.params),
      }));
    }),
  }));
}

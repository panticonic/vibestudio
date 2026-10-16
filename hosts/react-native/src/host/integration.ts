import {
  clientIntents,
  type ClientIntentDecl,
} from "@vibestudio/workspace-contracts/clients";

/**
 * How a client's declared intents become launch surfaces on this device
 * (docs/client-hosts-and-clients-plan.md 4.7). Everything here is generic: it
 * reads declarations, never a client by name. Plain functions over listings
 * and snapshots so the platform halves (a pinned shortcut, a share target, a
 * Quick Settings tile) stay thin.
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

/** Whether `mime` (parameters ignored) matches a pattern: exact, `type/*` or `*`. */
export function mimeAccepted(patterns: readonly string[], mime: string): boolean {
  const type = mime.split(";")[0]!.trim().toLowerCase();
  if (!/^[^/\s]+\/[^/\s]+$/u.test(type)) return false;
  return patterns.some((pattern) => {
    const wanted = pattern.trim().toLowerCase();
    if (wanted === "*" || wanted === "*/*") return true;
    if (wanted.endsWith("/*")) return type.startsWith(wanted.slice(0, -1));
    return type === wanted;
  });
}

/** The parameter an intent takes free text in: its first `text` parameter. */
export function textParamOf(intent: Pick<ClientIntentDecl, "params">): string | null {
  for (const [name, type] of Object.entries(intent.params ?? {})) if (type === "text") return name;
  return null;
}

/** The slice of a client listing the routing below reads. */
export interface ListedClient {
  id: string;
  runtime: string;
  isDefault: boolean;
  intents: readonly ClientIntentDecl[];
  unavailableReason?: string | undefined;
}

function runnable(listings: readonly ListedClient[]): ListedClient[] {
  return listings.filter(
    (listing) => listing.runtime === "react-native" && listing.unavailableReason === undefined
  );
}

function preferDefault<T extends { listing: ListedClient }>(candidates: T[]): T | null {
  return candidates.find((candidate) => candidate.listing.isDefault) ?? candidates[0] ?? null;
}

/**
 * The client a shared item goes to: one whose foreground intent accepts the
 * MIME type and takes free text, preferring the device's default client. The
 * intent is delivered `{ [textParam]: text }`.
 */
export function pickShareTarget(
  listings: readonly ListedClient[],
  mime: string
): { id: string; intent: string; textParam: string } | null {
  const candidates = runnable(listings).flatMap((listing) =>
    listing.intents.flatMap((intent) => {
      const textParam = textParamOf(intent);
      return intent.kind === "foreground" &&
        textParam !== null &&
        intent.accepts !== undefined &&
        mimeAccepted(intent.accepts, mime)
        ? [{ listing, intent: intent.name, textParam }]
        : [];
    })
  );
  const chosen = preferDefault(candidates);
  return chosen && { id: chosen.listing.id, intent: chosen.intent, textParam: chosen.textParam };
}

/** The client that declares background intent `name`, preferring the device's default client. */
export function pickBackgroundIntent(
  listings: readonly ListedClient[],
  name: string
): { id: string; intent: ClientIntentDecl } | null {
  const candidates = runnable(listings).flatMap((listing) =>
    listing.intents.flatMap((intent) =>
      intent.kind === "background" && intent.name === name ? [{ listing, intent }] : []
    )
  );
  const chosen = preferDefault(candidates);
  return chosen && { id: chosen.listing.id, intent: chosen.intent };
}

/** Whether a link may deliver `intent` to this client: only foreground intents it declares, and `open`. */
export function isForegroundIntent(listing: Pick<ListedClient, "intents">, intent: string): boolean {
  return clientIntents({ intents: [...listing.intents] }).some(
    (declared) => declared.kind === "foreground" && declared.name === intent
  );
}

/** One entry of the integration snapshot, as `clients.integrationSnapshot` returns it. */
export interface SnapshotClient {
  id: string;
  title: string;
  intents: readonly ClientIntentDecl[];
  entries: Readonly<Record<string, ReadonlyArray<{ title: string; params: Record<string, string> }>>>;
}

/** A launcher the person can ask the OS to pin. */
export interface PinnableShortcut {
  /** Stable per (client, intent, params): pinning twice updates rather than duplicates. */
  shortcutId: string;
  clientId: string;
  label: string;
  link: string;
}

/**
 * What can be pinned as a home-screen shortcut: a client's plain foreground
 * intents (`open` and any intent without parameters) and each dynamic entry of
 * a parameterized one. Intents that need input the person has not given
 * (share-in, intents with parameters and no entries) are not launchers.
 */
export function pinnableShortcuts(clients: readonly SnapshotClient[]): PinnableShortcut[] {
  return clients.flatMap((client) =>
    clientIntents({ intents: [...client.intents] }).flatMap((intent): PinnableShortcut[] => {
      if (intent.kind !== "foreground" || intent.accepts !== undefined) return [];
      const label = intent.name === "open" ? client.title : `${client.title}: ${intent.title ?? intent.name}`;
      const parameterless = Object.keys(intent.params ?? {}).length === 0;
      if (parameterless) {
        const link = clientIntentLink(client.id, intent.name);
        return [{ shortcutId: link, clientId: client.id, label, link }];
      }
      return (client.entries[intent.name] ?? []).map((entry) => {
        const link = clientIntentLink(client.id, intent.name, entry.params);
        return { shortcutId: link, clientId: client.id, label: entry.title, link };
      });
    })
  );
}

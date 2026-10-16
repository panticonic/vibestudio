import {
  clientIntentLink,
  launchEntries,
  textParamOf,
  type SnapshotClient,
} from "@vibestudio/client-host-core";
import {
  clientIntents,
  type ClientIntentDecl,
} from "@vibestudio/workspace-contracts/clients";

/**
 * How a client's declared intents become launch surfaces on this device
 * (docs/client-hosts-and-clients-plan.md 4.7). Everything here is generic: it
 * reads declarations, never a client by name. Plain functions over listings
 * and snapshots so the platform halves (a pinned shortcut, a share target, a
 * Quick Settings tile, an App Intent) stay thin. Link grammar and the plain
 * launch entries are `@vibestudio/client-host-core`'s, shared with every host.
 */

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

/**
 * The client that declares background intent `name`: the one a surface named
 * (`clientId`, an App Intent bound to a client), otherwise the device's default
 * client first.
 */
export function pickBackgroundIntent(
  listings: readonly ListedClient[],
  name: string,
  clientId?: string
): { id: string; intent: ClientIntentDecl } | null {
  const candidates = runnable(listings).flatMap((listing) =>
    listing.intents.flatMap((intent) =>
      intent.kind === "background" &&
      intent.name === name &&
      (clientId === undefined || listing.id === clientId)
        ? [{ listing, intent }]
        : []
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

/** One launchable item of a client, as native surfaces (shortcut menus, widgets, App Intents) receive it. */
export interface LaunchItem {
  intent: string;
  label: string;
  link: string;
}

/**
 * Everything native projects onto the OS, published whole after each refresh:
 * Android dynamic shortcuts and the widget; iOS App Intents, quick actions,
 * widgets and the share extension's routing. Native stores and renders it; it
 * decides nothing a declaration did not.
 */
export interface LaunchSurfaces {
  clients: Array<{
    clientId: string;
    title: string;
    /** Plain foreground intents (`open` first). */
    shortcuts: LaunchItem[];
    /** The dynamic entries of parameterized foreground intents (recent conversations). */
    recent: LaunchItem[];
  }>;
  /** Background intents that take free text (the `ask` family). */
  background: Array<{
    clientId: string;
    clientTitle: string;
    intent: string;
    title: string;
    textParam: string;
  }>;
  /** Foreground intents that accept shared items. */
  shareIn: Array<{
    clientId: string;
    clientTitle: string;
    intent: string;
    textParam: string;
    accepts: string[];
  }>;
}

export function launchSurfaces(clients: readonly SnapshotClient[]): LaunchSurfaces {
  const entries = new Map(launchEntries(clients).map((entry) => [entry.clientId, entry.entries]));
  const surfaces: LaunchSurfaces = { clients: [], background: [], shareIn: [] };
  for (const client of clients) {
    const declared = clientIntents({ intents: [...client.intents] });
    const dynamicIntents = new Set(
      declared.filter((intent) => intent.dynamic !== undefined).map((intent) => intent.name)
    );
    const items = entries.get(client.id) ?? [];
    const item = ({ intent, label, link }: (typeof items)[number]): LaunchItem => ({ intent, label, link });
    surfaces.clients.push({
      clientId: client.id,
      title: client.title,
      shortcuts: items.filter((entry) => !dynamicIntents.has(entry.intent)).map(item),
      recent: items.filter((entry) => dynamicIntents.has(entry.intent)).map(item),
    });
    for (const intent of declared) {
      const textParam = textParamOf(intent);
      if (textParam === null) continue;
      if (intent.kind === "background") {
        surfaces.background.push({
          clientId: client.id,
          clientTitle: client.title,
          intent: intent.name,
          title: intent.title ?? intent.name,
          textParam,
        });
      } else if (intent.accepts !== undefined) {
        surfaces.shareIn.push({
          clientId: client.id,
          clientTitle: client.title,
          intent: intent.name,
          textParam,
          accepts: [...intent.accepts],
        });
      }
    }
  }
  return surfaces;
}

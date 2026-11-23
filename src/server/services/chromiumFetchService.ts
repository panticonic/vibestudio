import {
  chromiumFetchMethods as methods,
  BROWSER_FETCH_PRESENTATION,
} from "@vibestudio/service-schemas/chromiumFetch";
import type {
  ServiceDefinition,
  FixedPreparedAuthoritySelection,
} from "@vibestudio/shared/serviceDefinition";
import {
  preparedAuthorityPayload,
  fixedPreparedAuthoritySelection,
} from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
export interface ChromiumFetchMetadata {
  responseId: string;
  url: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  size: number;
}

export interface ChromiumFetchServiceDeps {
  open(
    url: string,
    session: "public" | "browser",
    localGrant?: { hostConnectionId: string; origin: string }
  ): Promise<{ hostConnectionId: string; response: ChromiumFetchMetadata }>;
  /** Select only the exact child provider owned by this Host server. */
  resolveLocalHost(): Promise<string>;
  read(
    hostConnectionId: string,
    responseId: string,
    offset: number,
    limit: number
  ): Promise<{ bytesBase64: string; done: boolean }>;
  close(hostConnectionId: string, responseId: string): Promise<void>;
  /** A host's disconnect ends every response it held. */
  onHostDisconnected(listener: (hostConnectionId: string) => void): () => void;
  /** A runtime entity's retirement ends every response it opened. */
  onEntityRetired(listener: (entityId: string) => void): () => void;
  /**
   * A caller that is not a runtime entity (a shell or user session) retires
   * when it departs for good; that ends every response it opened.
   */
  onCallerRetired(listener: (callerId: string) => void): () => void;
  /** A host-side close that no caller is waiting on failed. */
  reportCloseFailure(responseId: string, error: unknown): void;
}

type HandlerContext = Parameters<ServiceDefinition["handler"]>[0];

export function createChromiumFetchService(
  deps: ChromiumFetchServiceDeps
): ServiceDefinition & { stop(): void } {
  const responses = new Map<
    string,
    { owner: string; ownerEntityId: string; hostConnectionId: string }
  >();
  const owner = (ctx: HandlerContext) =>
    ctx.authorization?.agentBinding?.channelId ?? ctx.caller.runtime.id;
  /** The runtime entity (or, for a shell or user session, the caller) whose lifetime bounds its open responses. */
  const ownerEntityId = (ctx: HandlerContext) =>
    ctx.caller.agentBinding?.entityId ?? ctx.caller.runtime.id;
  /** No caller waits on this close; its failure is reported, not dropped. */
  const closeUnobserved = (hostConnectionId: string, responseId: string) => {
    void deps
      .close(hostConnectionId, responseId)
      .catch((error: unknown) => deps.reportCloseFailure(responseId, error));
  };
  const stopHostListener = deps.onHostDisconnected((hostConnectionId) => {
    for (const [responseId, entry] of responses)
      if (entry.hostConnectionId === hostConnectionId) responses.delete(responseId);
  });
  const retireOwner = (ownerId: string) => {
    for (const [responseId, entry] of responses) {
      if (entry.ownerEntityId !== ownerId) continue;
      responses.delete(responseId);
      closeUnobserved(entry.hostConnectionId, responseId);
    }
  };
  const stopEntityListener = deps.onEntityRetired(retireOwner);
  const stopCallerListener = deps.onCallerRetired(retireOwner);
  const open = async (ctx: HandlerContext, url: string, session: "public" | "browser") => {
    const opened = await deps.open(url, session);
    responses.set(opened.response.responseId, {
      owner: owner(ctx),
      ownerEntityId: ownerEntityId(ctx),
      hostConnectionId: opened.hostConnectionId,
    });
    return opened.response;
  };
  const owned = (ctx: HandlerContext, responseId: string) => {
    const entry = responses.get(responseId);
    if (!entry || entry.owner !== owner(ctx)) throw new Error("Chromium response is unavailable");
    return entry;
  };
  return {
    name: "chromiumFetch",
    description: "Managed Chromium transport for web content retrieval",
    authority: { principals: ["code", "host", "user"] },
    methods,
    authorityPreparation: {
      ["chromiumFetch.openLocal.origin"]: async (ctx, [rawUrl, rawOrigin, session]) => {
        const url = new URL(String(rawUrl));
        const origin = new URL(String(rawOrigin));
        // This is request-shape validation. The native DNS/address boundary remains authoritative.
        if (
          !["http:", "https:"].includes(origin.protocol) ||
          origin.href !== origin.origin + "/" ||
          origin.username ||
          origin.password ||
          url.origin !== origin.origin
        )
          throw new Error("Local source request must name its exact HTTP(S) origin");
        const hostConnectionId = await deps.resolveLocalHost();
        const resource = { type: "website", label: "Local network source", value: origin.origin };
        const selections: FixedPreparedAuthoritySelection[] = [
          fixedPreparedAuthoritySelection({
            capability: "network.connect",
            resourceKey: origin.origin,
            challenge: {
              title: "Read a local network source",
              description: `Allow Chromium on this Host to read ${origin.origin}. Pages may also load public network content.`,
              deniedReason: "Local source access was not allowed",
              dedupKey: `chromium-local:${ctx.caller.runtime.id}:${hostConnectionId}:${origin.origin}`,
              resource,
              operation: {
                kind: "network",
                verb: "read a local network source",
                object: resource,
                groupKey: `chromium-local:${hostConnectionId}:${origin.origin}`,
              },
            },
          }),
        ];
        if (session === "browser" && (ctx.caller.code || ctx.caller.executionSession))
          selections.push(
            fixedPreparedAuthoritySelection({
              capability: "credential.use",
              resourceKey: origin.origin,
              challenge: {
                title: BROWSER_FETCH_PRESENTATION.title,
                description: BROWSER_FETCH_PRESENTATION.description,
                deniedReason: "Browser session use was not allowed",
                dedupKey: `chromium-fetch:${ctx.caller.runtime.id}:${origin.origin}`,
                resource,
                operation: {
                  kind: "browser",
                  verb: BROWSER_FETCH_PRESENTATION.action,
                  object: resource,
                  groupKey: `chromium-fetch:${origin.origin}`,
                },
              },
            })
          );
        return {
          selections,
          payload: { url: url.href, origin: origin.origin, session, hostConnectionId },
        };
      },
      ["chromiumFetch.openBrowser.origin"]: (ctx, [rawUrl]) => {
        if (!ctx.caller.code && !ctx.caller.executionSession)
          return { selections: [], payload: null };
        const origin = new URL(String(rawUrl)).origin;
        const resource = { type: "website", label: "Website", value: origin };
        return {
          selections: [
            fixedPreparedAuthoritySelection({
              capability: "credential.use",
              resourceKey: origin,
              challenge: {
                title: BROWSER_FETCH_PRESENTATION.title,
                description: BROWSER_FETCH_PRESENTATION.description,
                deniedReason: "Using the signed-in browser session was not allowed",
                dedupKey: `chromium-fetch:${ctx.caller.runtime.id}:${origin}`,
                resource,
                operation: {
                  kind: "browser",
                  verb: BROWSER_FETCH_PRESENTATION.action,
                  object: resource,
                  groupKey: `chromium-fetch:${ctx.caller.runtime.id}:${origin}`,
                },
              },
            }),
          ],
          payload: null,
        };
      },
    },
    handler: defineServiceHandler("chromiumFetch", methods, {
      openLocal: async (ctx, [url, origin, session]) => {
        const grant = preparedAuthorityPayload<{
          url: string;
          origin: string;
          session: "public" | "browser";
          hostConnectionId: string;
        }>(ctx, "chromiumFetch.openLocal.origin");
        if (
          new URL(url).href !== grant.url ||
          new URL(origin).origin !== grant.origin ||
          session !== grant.session ||
          !grant.hostConnectionId
        )
          throw new Error("Prepared local source does not match request");
        const opened = await deps.open(url, session, grant);
        if (opened.hostConnectionId !== grant.hostConnectionId)
          throw new Error("Local source provider differs from prepared grant");
        responses.set(opened.response.responseId, {
          owner: owner(ctx),
          ownerEntityId: ownerEntityId(ctx),
          hostConnectionId: opened.hostConnectionId,
        });
        return opened.response;
      },
      openPublic: (ctx, [url]) => open(ctx, url, "public"),
      openBrowser: (ctx, [url]) => open(ctx, url, "browser"),
      read: async (ctx, [responseId, offset, limit]) => {
        const entry = owned(ctx, responseId);
        const result = await deps.read(entry.hostConnectionId, responseId, offset, limit);
        if (result.done) {
          // The caller already holds these final bytes; releasing the host's
          // copy is cleanup that must not discard them.
          responses.delete(responseId);
          closeUnobserved(entry.hostConnectionId, responseId);
        }
        return result;
      },
      close: async (ctx, [responseId]) => {
        const entry = owned(ctx, responseId);
        responses.delete(responseId);
        await deps.close(entry.hostConnectionId, responseId);
      },
    }),
    stop() {
      stopHostListener();
      stopEntityListener();
      stopCallerListener();
    },
  };
}

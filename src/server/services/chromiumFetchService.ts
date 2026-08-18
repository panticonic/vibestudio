import { z } from "zod";
import { requirementForPrincipals } from "@vibestudio/shared/authorization";
import type { ServiceDefinition } from "@vibestudio/shared/serviceDefinition";
import { fixedPreparedAuthoritySelection } from "@vibestudio/shared/serviceDefinition";
import { defineServiceHandler } from "@vibestudio/shared/serviceHandlers";
import {
  defineServiceMethods,
  fixedPreparedAuthorityRequirement,
} from "@vibestudio/shared/typedServiceClient";
const BROWSER_FETCH_CAPABILITY = "credential.use";
const BROWSER_FETCH_RESOLVER = "chromiumFetch.openBrowser.origin";
const BROWSER_FETCH_PRESENTATION = {
  title: "Use your browser session",
  action: "load a website using your signed-in browser session",
  description:
    "Load the website as a normal browser page with cookies imported into Vibestudio. The page may make authenticated requests or update your account or session.",
  group: "accounts",
  authorityCategory: { domain: "accounts", verb: "act" },
} as const;
const responseMetadata = z.object({
  responseId: z.string().uuid(),
  url: z.string().url(),
  status: z.number().int(),
  statusText: z.string(),
  headers: z.record(z.string()),
  size: z.number().int().nonnegative(),
});
const openTier = {
  tier: "open" as const,
  session: "family" as const,
  residency: "native-effect" as const,
  family: "chromiumFetch.transport",
  rationale:
    "The agent already owns web-fetch authority; this selects the canonical native Chromium transport",
};

const methods = defineServiceMethods({
  openPublic: {
    tier: openTier,
    description: "Open a cookie-free URL through the managed Chromium host.",
    args: z.tuple([z.string().url()]),
    returns: responseMetadata,
    authority: { principals: ["code", "host", "user"] },
    access: { sensitivity: "read" as const },
  },
  openBrowser: {
    capability: BROWSER_FETCH_CAPABILITY,
    tier: openTier,
    presentation: BROWSER_FETCH_PRESENTATION,
    description: "Open a URL through Chromium with the user's canonical browser cookies.",
    args: z.tuple([z.string().url()]),
    returns: responseMetadata,
    authority: {
      requirement: requirementForPrincipals(["user", "host", "code"], BROWSER_FETCH_CAPABILITY),
      resource: { kind: "literal", key: BROWSER_FETCH_CAPABILITY },
      prepared: {
        resolver: BROWSER_FETCH_RESOLVER,
        leaves: [
          {
            capability: BROWSER_FETCH_CAPABILITY,
            requirement: fixedPreparedAuthorityRequirement(
              requirementForPrincipals(["code"], BROWSER_FETCH_CAPABILITY)
            ),
            tier: "gated",
          },
        ],
      },
    },
    access: { sensitivity: "read" as const },
  },
  read: {
    tier: openTier,
    description: "Read an owner-bound chunk from an open Chromium response.",
    args: z.tuple([
      z.string().uuid(),
      z.number().int().nonnegative(),
      z.number().int().min(1).max(524_288),
    ]),
    returns: z.object({ bytesBase64: z.string(), done: z.boolean() }),
    authority: { principals: ["code", "host", "user"] },
    access: { sensitivity: "read" as const },
  },
  close: {
    tier: openTier,
    description: "Close an owner-bound Chromium response.",
    args: z.tuple([z.string().uuid()]),
    returns: z.void(),
    authority: { principals: ["code", "host", "user"] },
    access: { sensitivity: "read" as const },
  },
});

export interface ChromiumFetchMetadata {
  responseId: string;
  url: string;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  size: number;
}

export function createChromiumFetchService(deps: {
  open(
    url: string,
    session: "public" | "browser"
  ): Promise<{ hostConnectionId: string; response: ChromiumFetchMetadata }>;
  read(
    hostConnectionId: string,
    responseId: string,
    offset: number,
    limit: number
  ): Promise<{ bytesBase64: string; done: boolean }>;
  close(hostConnectionId: string, responseId: string): Promise<void>;
}): ServiceDefinition {
  const responses = new Map<string, { owner: string; hostConnectionId: string }>();
  const owner = (ctx: Parameters<ServiceDefinition["handler"]>[0]) =>
    ctx.authorization?.agentBinding?.channelId ?? ctx.caller.runtime.id;
  const open = async (
    ctx: Parameters<ServiceDefinition["handler"]>[0],
    url: string,
    session: "public" | "browser"
  ) => {
    const opened = await deps.open(url, session);
    responses.set(opened.response.responseId, {
      owner: owner(ctx),
      hostConnectionId: opened.hostConnectionId,
    });
    return opened.response;
  };
  const owned = (ctx: Parameters<ServiceDefinition["handler"]>[0], responseId: string) => {
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
      [BROWSER_FETCH_RESOLVER]: (ctx, [rawUrl]) => {
        if (!ctx.caller.code && !ctx.caller.executionSession)
          return { selections: [], payload: null };
        const origin = new URL(String(rawUrl)).origin;
        const resource = { type: "website", label: "Website", value: origin };
        return {
          selections: [
            fixedPreparedAuthoritySelection({
              capability: BROWSER_FETCH_CAPABILITY,
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
      openPublic: (ctx, [url]) => open(ctx, url, "public"),
      openBrowser: (ctx, [url]) => open(ctx, url, "browser"),
      read: async (ctx, [responseId, offset, limit]) => {
        const entry = owned(ctx, responseId);
        const result = await deps.read(entry.hostConnectionId, responseId, offset, limit);
        if (result.done) {
          responses.delete(responseId);
          await deps.close(entry.hostConnectionId, responseId);
        }
        return result;
      },
      close: async (ctx, [responseId]) => {
        const entry = owned(ctx, responseId);
        responses.delete(responseId);
        await deps.close(entry.hostConnectionId, responseId);
      },
    }),
  };
}

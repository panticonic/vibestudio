import { z } from "zod";
import { requirementForPrincipals } from "@vibestudio/shared/authorization";
import {
  defineServiceMethods,
  fixedPreparedAuthorityRequirement,
} from "@vibestudio/shared/typedServiceClient";
const BROWSER_FETCH_CAPABILITY = "credential.use";
const BROWSER_FETCH_RESOLVER = "chromiumFetch.openBrowser.origin";
export const BROWSER_FETCH_PRESENTATION = {
  title: "Use your signed-in browser",
  action: "load a website using your signed-in browser",
  description:
    "Load the website as a normal browser page with cookies imported into Vibestudio. The page may make authenticated requests or update your account.",
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

export const chromiumFetchMethods = defineServiceMethods({
  openPublic: {
    website: {
      kind: "closed",
      reason:
        "The chromiumFetchService receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations.",
    } as const,
    tier: openTier,
    description: "Open a cookie-free URL through the managed Chromium host.",
    args: z.tuple([z.string().url()]),
    returns: responseMetadata,
    authority: { principals: ["code", "host", "user"] },
    access: { sensitivity: "read" as const },
  },
  openBrowser: {
    website: {
      kind: "closed",
      reason:
        "The chromiumFetchService receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations.",
    } as const,
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
    website: {
      kind: "closed",
      reason:
        "The chromiumFetchService receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations.",
    } as const,
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
    website: {
      kind: "closed",
      reason:
        "The chromiumFetchService receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations.",
    } as const,
    tier: openTier,
    description: "Close an owner-bound Chromium response.",
    args: z.tuple([z.string().uuid()]),
    returns: z.void(),
    authority: { principals: ["code", "host", "user"] },
    access: { sensitivity: "read" as const },
  },
});

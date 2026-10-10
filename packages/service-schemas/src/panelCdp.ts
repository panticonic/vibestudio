import { z } from "zod";
import { requirementForPrincipals } from "@vibestudio/shared/authorization";
import {
  defineServiceMethods,
  fixedPreparedAuthorityRequirement,
} from "@vibestudio/shared/typedServiceClient";
const consoleHistoryOptionsSchema = z
  .object({
    limit: z.number().int().min(1).max(1000).optional(),
    errorLimit: z.number().int().min(0).max(500).optional(),
    levels: z.array(z.enum(["debug", "info", "warning", "error", "unknown"])).optional(),
    sources: z.array(z.enum(["console", "lifecycle"])).optional(),
    contains: z.string().max(512).optional(),
    since: z.number().optional(),
    until: z.number().optional(),
    beforeSeq: z.number().int().positive().optional(),
  })
  .optional();

const screenshotOptionsSchema = z
  .object({
    format: z.enum(["png", "jpeg"]).optional(),
    quality: z.number().min(0).max(100).optional(),
  })
  .optional();

const evaluateOptionsSchema = z
  .object({
    timeoutMs: z.number().positive().optional(),
    valueLimit: z.number().positive().optional(),
  })
  .optional();

const evaluateResultSchema = z.object({
  ok: z.boolean(),
  type: z.string(),
  value: z.string().nullable(),
  error: z.string().nullable(),
  truncated: z.boolean(),
});

export const panelScreenshotResultSchema = z.object({
  data: z.string(),
  mimeType: z.enum(["image/png", "image/jpeg"]),
  width: z.number(),
  height: z.number(),
});

function cdpBoundaryAuthority(method: string) {
  // Minting the raw CDP endpoint is the one promptable primary effect. Bind it
  // to the stable user-facing capability; the wire method name is transport,
  // not authority vocabulary. The other CDP helpers are open primary methods
  // whose dynamically selected cross-context leaf remains independently gated.
  const capability = method === "getCdpEndpoint" ? "panel.inspect" : `service:panelCdp.${method}`;
  return {
    requirement: requirementForPrincipals(["code", "user", "host"], capability),
    resource: {
      kind: "argument" as const,
      index: 0,
      presentation: { type: "panel", label: "Panel" },
    },
    prepared: {
      resolver: `panelCdp.${method}.contextBoundary`,
      leaves: [
        {
          capability: "context.boundary",
          requirement: fixedPreparedAuthorityRequirement(
            requirementForPrincipals(["code", "user", "host"], "context.boundary")
          ),
          tier: { selectedFrom: ["gated", "critical"] as const },
        },
      ],
    },
  };
}

const consoleEntrySchema = z.object({
  seq: z.number().optional(),
  timestamp: z.number(),
  level: z.enum(["debug", "info", "warning", "error", "unknown"]),
  message: z.string(),
  line: z.number(),
  sourceId: z.string(),
  url: z.string(),
  source: z.enum(["console", "lifecycle"]).optional(),
  fields: z.record(z.unknown()).optional(),
});
export const panelConsoleHistoryResultSchema = z.object({
  entries: z.array(consoleEntrySchema),
  errors: z.array(consoleEntrySchema),
  page: z.object({ nextBeforeSeq: z.number().nullable(), hasOlder: z.boolean() }),
  dropped: z.object({ entries: z.number(), errors: z.number() }),
  capacity: z.object({ entries: z.number(), errors: z.number() }),
});

export const panelCdpMethods = defineServiceMethods({
  getCdpEndpoint: {
    website: {
      kind: "closed",
      reason:
        "The panelCdpService receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations.",
    } as const,
    capability: "panel.inspect",
    tier: {
      tier: "gated",
      session: "family",
      residency: "transport",
      family: "cdp.transport",
      rationale:
        "Mints one short-lived authenticated endpoint for the exact already-authorized native CDP target",
    },
    presentation: {
      title: "Inspect a panel with developer tools",
      action: "inspect a panel with developer tools",
      description: "Allows {requesterKind} to inspect a panel with developer tools.",
      group: "panels",
      authorityCategory: {
        domain: "computer",
        verb: "see",
      },
    },
    description: "Return a single-use CDP WebSocket endpoint for an approved panel target.",
    args: z.tuple([z.string()]),
    returns: z.object({ wsEndpoint: z.string(), token: z.string().optional() }).strict(),
    authority: cdpBoundaryAuthority("getCdpEndpoint"),
    access: { sensitivity: "admin" },
  },
  stop: {
    website: {
      kind: "closed",
      reason:
        "The panelCdpService receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations.",
    } as const,
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "cdp.native-effect",
      rationale:
        "Stops loading in the exact native webContents selected by the receiver-bound target",
    },
    description: "Stop loading an approved panel target through its active CDP host.",
    args: z.tuple([z.string()]),
    authority: cdpBoundaryAuthority("stop"),
    access: { sensitivity: "write" },
  },
  browserOperation: {
    website: {
      kind: "closed",
      reason: "Native browser activity is scoped to an approved panel target.",
    } as const,
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "cdp.native-effect",
      rationale:
        "The owning provider observes popups and reads only its own panel download records",
    },
    description:
      "Inspect, cancel, and read approved native downloads without exposing host filesystem paths.",
    args: z.tuple([
      z.string(),
      z.discriminatedUnion("operation", [
        z.object({ operation: z.literal("listDownloads") }).strict(),
        z.object({ operation: z.literal("downloadInfo"), id: z.string() }).strict(),
        z.object({ operation: z.literal("downloadFinished"), id: z.string() }).strict(),
        z.object({ operation: z.literal("cancelDownload"), id: z.string() }).strict(),
        z
          .object({
            operation: z.literal("readDownloadChunk"),
            id: z.string(),
            offset: z.number().int().nonnegative(),
            length: z.number().int().min(1).max(262144),
          })
          .strict(),
      ]),
    ]),
    authority: cdpBoundaryAuthority("browserOperation"),
    access: { sensitivity: "write" },
  },
  consoleHistory: {
    website: {
      kind: "closed",
      reason:
        "The panelCdpService receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations.",
    } as const,
    tier: {
      tier: "open",
      session: "family",
      residency: "transport",
      family: "cdp.transport",
      rationale: "Returns a bounded observation from the exact authenticated native CDP provider",
    },
    description: "Read console history from an approved panel target's active CDP host.",
    args: z.tuple([z.string(), consoleHistoryOptionsSchema]),
    returns: panelConsoleHistoryResultSchema,
    authority: cdpBoundaryAuthority("consoleHistory"),
    access: { sensitivity: "read" },
  },
  evaluate: {
    website: {
      kind: "closed",
      reason:
        "The panelCdpService receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations.",
    } as const,
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "cdp.native-effect",
      rationale:
        "Runs one bounded expression in the exact native view selected by receiver-bound target authority",
    },
    description:
      "Evaluate one expression in an approved panel target through its active CDP host. " +
      "The expression runs under a bounded wrapper (8s) and the result is serialized to a " +
      "string, so no CDP WebSocket client is needed for the common inspect-and-poke case.",
    args: z.tuple([z.string(), z.string(), evaluateOptionsSchema]),
    returns: evaluateResultSchema,
    authority: cdpBoundaryAuthority("evaluate"),
    // Arbitrary page script can mutate the document it runs in; this is not a
    // read-only observation even when the caller only means to look.
    access: { sensitivity: "write" },
  },
  reload: {
    website: {
      kind: "closed",
      reason:
        "The panelCdpService receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations.",
    } as const,
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "cdp.native-effect",
      rationale:
        "Reloads the exact receiver-bound panel generation without exposing its host lease mechanics",
    },
    description: "Reload an approved panel target through its product lifecycle.",
    args: z.tuple([z.string()]),
    returns: z.void(),
    authority: cdpBoundaryAuthority("reload"),
    access: { sensitivity: "write" },
  },
  screenshot: {
    website: {
      kind: "closed",
      reason:
        "The panelCdpService receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations.",
    } as const,
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "cdp.native-effect",
      rationale:
        "Force-paints and captures the exact native view selected by receiver-bound target authority",
    },
    description:
      "Capture a screenshot of an approved panel target through its active CDP host " +
      "(force-paints hidden/unslotted panels). Returns base64 image data + mime type; " +
      "no CDP WebSocket client needed.",
    args: z.tuple([z.string(), screenshotOptionsSchema]),
    returns: panelScreenshotResultSchema,
    authority: cdpBoundaryAuthority("screenshot"),
    access: { sensitivity: "read" },
  },
  "hostProvider.open": {
    website: {
      kind: "closed",
      reason:
        "The panelCdpService receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations.",
    } as const,
    capability: "panel.inspect",
    tier: {
      tier: "gated",
      session: "family",
      residency: "transport",
      family: "cdp.transport",
      rationale: "Opens one authenticated provider stream for an already-minted exact CDP session",
    },
    presentation: {
      title: "Inspect a panel",
      action: "inspect a panel",
      description: "Allows {requesterKind} to inspect a panel.",
      group: "panels",
      authorityCategory: {
        domain: "computer",
        verb: "see",
      },
    },
    description: "Internal shell/server transport: open a streamed CDP host-provider channel.",
    args: z.tuple([z.string(), z.string()]),
    returns: z.instanceof(Response),
    authority: { principals: ["user", "host"] },
    access: { sensitivity: "admin" as const },
  },
  "hostProvider.send": {
    website: {
      kind: "closed",
      reason:
        "The panelCdpService receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations.",
    } as const,
    capability: "panel.inspect",
    tier: {
      tier: "gated",
      session: "family",
      residency: "transport",
      family: "cdp.transport",
      rationale:
        "Relays one frame inside the exact authenticated CDP provider session without product policy",
    },
    presentation: {
      title: "Control an inspected panel",
      action: "control an inspected panel",
      description: "Allows {requesterKind} to control an inspected panel.",
      group: "panels",
      authorityCategory: {
        domain: "computer",
        verb: "see",
      },
    },
    description:
      "Internal shell/server transport: deliver a CDP host-provider frame to the bridge.",
    args: z.tuple([z.string(), z.string()]),
    returns: z.void(),
    authority: { principals: ["user", "host"] },
    access: { sensitivity: "admin" as const },
  },
  "hostProvider.close": {
    website: {
      kind: "closed",
      reason:
        "The panelCdpService receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations.",
    } as const,
    capability: "panel.inspect",
    tier: {
      tier: "gated",
      session: "family",
      residency: "transport",
      family: "cdp.transport",
      rationale:
        "Closes the exact authenticated CDP provider stream and only reduces transport authority",
    },
    presentation: {
      title: "Stop inspecting a panel",
      action: "stop inspecting a panel",
      description: "Allows {requesterKind} to stop inspecting a panel.",
      group: "panels",
      authorityCategory: {
        domain: "computer",
        verb: "see",
      },
    },
    description: "Internal shell/server transport: close a CDP host-provider channel.",
    args: z.tuple([z.string()]),
    returns: z.void(),
    authority: { principals: ["user", "host"] },
    access: { sensitivity: "admin" as const },
  },
});

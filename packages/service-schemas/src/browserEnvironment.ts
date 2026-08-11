import { z } from "zod";
import {
  defineServiceMethods,
  selectedPreparedAuthorityRequirement,
} from "@vibestudio/shared/typedServiceClient";
import type { CapabilityPresentation } from "@vibestudio/shared/authorityPresentation";
import {
  BrowserImportDataTypeSchema,
  BrowserImportSourceSchema,
  ImportCategoryProgressSchema,
  ImportHostSummarySchema,
} from "@vibestudio/browser-contracts/import";
import { requirementForPrincipals } from "@vibestudio/shared/authorization";

export const BROWSER_ENVIRONMENT_BROKER_AUTHORITY_PREFIX = "browserEnvironment.broker";

function brokerPolicy(method: string, presentation: CapabilityPresentation) {
  const capability = `service:browserEnvironment.${method}`;
  return {
    capability,
    presentation,
    authority: {
      requirement: requirementForPrincipals(["host", "code"], capability),
      resource: { kind: "literal" as const, key: capability },
      prepared: {
        resolver: `${BROWSER_ENVIRONMENT_BROKER_AUTHORITY_PREFIX}.${method}`,
        leaves: [
          {
            capability,
            requirement: selectedPreparedAuthorityRequirement(["code"]),
            tier: "gated" as const,
          },
        ],
      },
    },
  };
}

const DownloadRecordSchema = z.object({
  id: z.string(),
  environmentKey: z.string(),
  hostId: z.string(),
  panelId: z.string().optional(),
  origin: z.string().optional(),
  url: z.string(),
  filename: z.string(),
  savePath: z.string(),
  receivedBytes: z.number().nonnegative(),
  totalBytes: z.number().nonnegative(),
  state: z.enum(["progressing", "paused", "completed", "cancelled", "interrupted"]),
  startedAt: z.number(),
  updatedAt: z.number(),
});

const ImportSummarySchema = z.object({
  dataTypes: z.array(ImportCategoryProgressSchema),
  warnings: z.array(z.string()),
});

const ImportCategoryBreakdownSchema = z.object({
  dataType: BrowserImportDataTypeSchema,
  groupedBy: z.enum(["site", "kind"]),
  total: z.number().int().nonnegative(),
  groups: z.array(z.object({ label: z.string(), count: z.number().int().nonnegative() })),
  otherGroups: z.number().int().nonnegative(),
  otherItems: z.number().int().nonnegative(),
});

const ImportedOpenTabSchema = z.object({
  tabId: z.string(),
  url: z.string().url(),
  title: z.string().optional(),
  active: z.boolean(),
  pinned: z.boolean().optional(),
  lastAccessed: z.number().optional(),
  windowId: z.string(),
  windowOrdinal: z.number().int().positive(),
  sessionState: z.enum(["open", "restores", "saved"]),
});

const ImportProviderFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("heartbeat") }),
  z.object({
    type: z.literal("batch"),
    dataType: BrowserImportDataTypeSchema,
    batchIndex: z.number().int().nonnegative(),
    items: z.array(z.unknown()),
  }),
  z.object({ type: z.literal("progress"), progress: ImportCategoryProgressSchema }),
  z.object({ type: z.literal("complete"), summary: ImportSummarySchema }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);

export const browserEnvironmentMethods = defineServiceMethods({
  getImportHost: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "browserEnvironment.read",
      rationale:
        "Host/code read of the browser-import host descriptor; per-method authority principals gate callers.",
    },
    description: "Describe the trusted browser-import provider on this host.",
    args: z.tuple([]),
    returns: ImportHostSummarySchema,
    access: { sensitivity: "read" },
    ...brokerPolicy("getImportHost", {
      title: "Access browser import details",
      action: "access browser import details",
      description: "Allows {requesterKind} to inspect the available browser import provider.",
      group: "network",
      authorityCategory: { domain: "web", verb: "see" },
    }),
  },
  listImportSources: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "browserEnvironment.read",
      rationale:
        "Enumerates importable external browser profiles; read-only discovery gated by authority principals.",
    },
    description: "List opaque browser sources discoverable by this trusted host.",
    args: z.tuple([]),
    returns: z.array(BrowserImportSourceSchema),
    access: { sensitivity: "read" },
    ...brokerPolicy("listImportSources", {
      title: "Find browser profiles to import",
      action: "find browser profiles to import",
      description: "Allows {requesterKind} to find browser profiles available for import.",
      group: "network",
      authorityCategory: { domain: "web", verb: "see" },
    }),
  },
  previewImportSource: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "browserEnvironment.control",
      rationale:
        "Read-only preview of an external browser profile import; gated by authority principals.",
    },
    description: "Preview normalized import counts without exposing browser secrets.",
    args: z.tuple([z.string().min(1), z.array(BrowserImportDataTypeSchema).min(1)]),
    returns: ImportSummarySchema.extend({
      breakdowns: z.array(ImportCategoryBreakdownSchema),
      openTabCount: z.number().int().nonnegative(),
      localDataSetCount: z.number().int().nonnegative(),
    }),
    access: { sensitivity: "read" },
    ...brokerPolicy("previewImportSource", {
      title: "Preview browser data for import",
      action: "preview browser data for import",
      description: "Allows {requesterKind} to preview browser data available for import.",
      group: "network",
      authorityCategory: { domain: "web", verb: "see" },
    }),
  },
  startImportRead: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "browserEnvironment.create",
      rationale:
        "Starts a streamed read of an external browser profile for import; gated by authority principals.",
    },
    description: "Start a bounded, cancellable read from an opaque browser source.",
    args: z.tuple([z.string().min(1), z.array(BrowserImportDataTypeSchema).min(1)]),
    returns: z.string().min(1),
    access: { sensitivity: "read" },
    ...brokerPolicy("startImportRead", {
      title: "Read browser data for import",
      action: "read browser data for import",
      description: "Allows {requesterKind} to read browser data selected for import.",
      group: "network",
      authorityCategory: { domain: "web", verb: "see" },
    }),
  },
  nextImportFrame: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "browserEnvironment.control",
      rationale: "Continues a streamed browser-profile import read; gated by authority principals.",
    },
    description: "Read the next bounded progress or data frame from an import operation.",
    args: z.tuple([z.string().min(1)]),
    returns: ImportProviderFrameSchema,
    access: { sensitivity: "read" },
    ...brokerPolicy("nextImportFrame", {
      title: "Continue reading browser data",
      action: "continue reading browser data for import",
      description: "Allows {requesterKind} to continue a browser data import read.",
      group: "network",
      authorityCategory: { domain: "web", verb: "see" },
    }),
  },
  cancelImportRead: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "browserEnvironment.retire",
      rationale: "Cancels a streamed browser-profile import read; gated by authority principals.",
    },
    description: "Cancel an active trusted-host browser import read.",
    args: z.tuple([z.string().min(1)]),
    returns: z.void(),
    access: { sensitivity: "write" },
    ...brokerPolicy("cancelImportRead", {
      title: "Cancel browser data reading",
      action: "cancel browser data reading",
      description: "Allows {requesterKind} to cancel an active browser data import read.",
      group: "network",
      authorityCategory: { domain: "web", verb: "manage" },
    }),
  },
  listImportOpenTabs: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "browserEnvironment.read",
      rationale:
        "Reads open tabs from an external browser profile for import; gated by authority principals.",
    },
    description: "List importable HTTP(S) tabs without exposing source filesystem paths.",
    args: z.tuple([z.string().min(1)]),
    returns: z.array(ImportedOpenTabSchema),
    access: { sensitivity: "read" },
    ...brokerPolicy("listImportOpenTabs", {
      title: "View browser tabs available to import",
      action: "view browser tabs available to import",
      description: "Allows {requesterKind} to view browser tabs available for import.",
      group: "network",
      authorityCategory: { domain: "web", verb: "see" },
    }),
  },
  flushCookieProjection: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "browserEnvironment.control",
      rationale:
        "Host maintenance proceeds directly; installed code requires the method's gated browser-environment capability.",
    },
    description: "Flush local cookie changes and reconcile the canonical browser jar.",
    args: z.tuple([z.array(z.string().url()).max(50)]),
    returns: z.object({ revision: z.number().int().nonnegative() }),
    access: { sensitivity: "write" },
    ...brokerPolicy("flushCookieProjection", {
      title: "Synchronize website cookies",
      action: "synchronize website cookies",
      description: "Allows {requesterKind} to reconcile website cookies with the browser host.",
      group: "network",
      authorityCategory: { domain: "web", verb: "manage" },
    }),
  },
  getCookieProjectionDiagnostics: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "browserEnvironment.read",
      rationale:
        "Host diagnostics proceed directly; installed code requires the method's gated browser-environment capability.",
    },
    description: "Read cookie-projection convergence diagnostics for this browser host.",
    args: z.tuple([]),
    returns: z.object({
      revision: z.number().int().nonnegative(),
      hostId: z.string(),
      converged: z.boolean(),
      mismatchCount: z.number().int().nonnegative(),
      outboxDepth: z.number().int().nonnegative(),
      lastError: z.string().optional(),
    }),
    access: { sensitivity: "read" },
    ...brokerPolicy("getCookieProjectionDiagnostics", {
      title: "View cookie synchronization diagnostics",
      action: "view cookie synchronization diagnostics",
      description: "Allows {requesterKind} to inspect website cookie synchronization status.",
      group: "network",
      authorityCategory: { domain: "web", verb: "see" },
    }),
  },
  listDownloads: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "browserEnvironment.read",
      rationale:
        "Host reads proceed directly; installed code requires the method's gated browser-environment capability.",
    },
    description: "List current and recent downloads for this browser host.",
    args: z.tuple([]),
    returns: z.array(DownloadRecordSchema),
    access: { sensitivity: "read" },
    ...brokerPolicy("listDownloads", {
      title: "View browser downloads",
      action: "view browser downloads",
      description: "Allows {requesterKind} to view current and recent browser downloads.",
      group: "network",
      authorityCategory: { domain: "web", verb: "see" },
    }),
  },
  pauseDownload: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "browserEnvironment.control",
      rationale:
        "Host control proceeds directly; installed code requires the method's gated browser-environment capability.",
    },
    description: "Pause an active browser download.",
    args: z.tuple([z.string()]),
    returns: z.void(),
    access: { sensitivity: "write" },
    ...brokerPolicy("pauseDownload", {
      title: "Pause browser downloads",
      action: "pause browser downloads",
      description: "Allows {requesterKind} to pause active browser downloads.",
      group: "network",
      authorityCategory: { domain: "web", verb: "manage" },
    }),
  },
  resumeDownload: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "browserEnvironment.control",
      rationale:
        "Host control proceeds directly; installed code requires the method's gated browser-environment capability.",
    },
    description: "Resume a paused browser download.",
    args: z.tuple([z.string()]),
    returns: z.void(),
    access: { sensitivity: "write" },
    ...brokerPolicy("resumeDownload", {
      title: "Resume browser downloads",
      action: "resume browser downloads",
      description: "Allows {requesterKind} to resume paused browser downloads.",
      group: "network",
      authorityCategory: { domain: "web", verb: "manage" },
    }),
  },
  cancelDownload: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "browserEnvironment.retire",
      rationale:
        "Host control proceeds directly; installed code requires the method's gated browser-environment capability.",
    },
    description: "Cancel an active browser download.",
    args: z.tuple([z.string()]),
    returns: z.void(),
    access: { sensitivity: "destructive" },
    ...brokerPolicy("cancelDownload", {
      title: "Cancel browser downloads",
      action: "cancel browser downloads",
      description: "Allows {requesterKind} to cancel active browser downloads.",
      group: "network",
      authorityCategory: { domain: "web", verb: "manage" },
    }),
  },
  openDownload: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "browserEnvironment.create",
      rationale:
        "Host open proceeds directly; installed code requires the method's gated browser-environment capability.",
    },
    description: "Open a completed browser download with the operating system.",
    args: z.tuple([z.string()]),
    returns: z.void(),
    access: { sensitivity: "write" },
    ...brokerPolicy("openDownload", {
      title: "Open downloaded files",
      action: "open downloaded files",
      description: "Allows {requesterKind} to open downloaded files on this computer.",
      group: "network",
      authorityCategory: { domain: "computer", verb: "act" },
    }),
  },
  revealDownload: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "browserEnvironment.control",
      rationale:
        "Host reveal proceeds directly; installed code requires the method's gated browser-environment capability.",
    },
    description: "Reveal a browser download in the operating system file manager.",
    args: z.tuple([z.string()]),
    returns: z.void(),
    access: { sensitivity: "write" },
    ...brokerPolicy("revealDownload", {
      title: "Show downloaded files",
      action: "show downloaded files on this computer",
      description: "Allows {requesterKind} to reveal downloaded files in the file manager.",
      group: "network",
      authorityCategory: { domain: "computer", verb: "act" },
    }),
  },
});

import { z } from "zod";
import {
  defineServiceMethods,
  selectedPreparedAuthorityRequirement,
} from "@vibestudio/shared/typedServiceClient";
import {
  BrowserImportDataTypeSchema,
  BrowserImportSourceSchema,
  ImportCategoryProgressSchema,
  ImportHostSummarySchema,
} from "@vibestudio/browser-data";
import { requirementForPrincipals } from "@vibestudio/shared/authorization";

export const BROWSER_ENVIRONMENT_BROKER_AUTHORITY_PREFIX = "browserEnvironment.broker";

function brokerAuthority(method: string) {
  const capability = `service:browserEnvironment.${method}`;
  return {
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
    authority: brokerAuthority("getImportHost"),
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
    authority: brokerAuthority("listImportSources"),
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
    authority: brokerAuthority("previewImportSource"),
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
    authority: brokerAuthority("startImportRead"),
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
    authority: brokerAuthority("nextImportFrame"),
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
    authority: brokerAuthority("cancelImportRead"),
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
    authority: brokerAuthority("listImportOpenTabs"),
  },
  flushCookieProjection: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "browserEnvironment.control",
      rationale:
        "Host-principal-only browser environment maintenance; the authority principal gate keeps prompts/code out.",
    },
    description: "Flush local cookie changes and reconcile the canonical browser jar.",
    args: z.tuple([z.array(z.string().url()).max(50)]),
    returns: z.object({ revision: z.number().int().nonnegative() }),
    access: { sensitivity: "write" },
    authority: brokerAuthority("flushCookieProjection"),
  },
  getCookieProjectionDiagnostics: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "browserEnvironment.read",
      rationale:
        "Host-principal-only diagnostics read for the browser environment cookie projection.",
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
    authority: brokerAuthority("getCookieProjectionDiagnostics"),
  },
  listDownloads: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "browserEnvironment.read",
      rationale: "Host-principal-only read of the browser environment download ledger.",
    },
    description: "List current and recent downloads for this browser host.",
    args: z.tuple([]),
    returns: z.array(DownloadRecordSchema),
    access: { sensitivity: "read" },
    authority: brokerAuthority("listDownloads"),
  },
  pauseDownload: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "browserEnvironment.control",
      rationale: "Host-principal-only download control driven by explicit shell UI.",
    },
    description: "Pause an active browser download.",
    args: z.tuple([z.string()]),
    returns: z.void(),
    access: { sensitivity: "write" },
    authority: brokerAuthority("pauseDownload"),
  },
  resumeDownload: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "browserEnvironment.control",
      rationale: "Host-principal-only download control driven by explicit shell UI.",
    },
    description: "Resume a paused browser download.",
    args: z.tuple([z.string()]),
    returns: z.void(),
    access: { sensitivity: "write" },
    authority: brokerAuthority("resumeDownload"),
  },
  cancelDownload: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "browserEnvironment.retire",
      rationale: "Host-principal-only download control driven by explicit shell UI.",
    },
    description: "Cancel an active browser download.",
    args: z.tuple([z.string()]),
    returns: z.void(),
    access: { sensitivity: "destructive" },
    authority: brokerAuthority("cancelDownload"),
  },
  openDownload: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "browserEnvironment.create",
      rationale: "Host-principal-only open of a completed download, driven by explicit shell UI.",
    },
    description: "Open a completed browser download with the operating system.",
    args: z.tuple([z.string()]),
    returns: z.void(),
    access: { sensitivity: "write" },
    authority: brokerAuthority("openDownload"),
  },
  revealDownload: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "browserEnvironment.control",
      rationale:
        "Host-principal-only reveal of a completed download in the file manager, driven by explicit shell UI.",
    },
    description: "Reveal a browser download in the operating system file manager.",
    args: z.tuple([z.string()]),
    returns: z.void(),
    access: { sensitivity: "write" },
    authority: brokerAuthority("revealDownload"),
  },
});

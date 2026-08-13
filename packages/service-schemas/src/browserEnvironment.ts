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
import type { ServiceAuthorityPolicy } from "@vibestudio/shared/serviceAuthority";

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

const reviewedProviderAuthority = {
  authority: { principals: ["host", "code"] } satisfies ServiceAuthorityPolicy,
};

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

export const BrowserPublicImportDataTypeSchema = z.enum([
  "bookmarks",
  "history",
  "searchEngines",
  "favicons",
]);
export const BrowserSensitiveImportDataTypeSchema = z.enum(["cookies", "passwords", "formFill"]);

const PublicImportCategoryProgressSchema = ImportCategoryProgressSchema.extend({
  dataType: BrowserPublicImportDataTypeSchema,
});
const PublicImportSummarySchema = z
  .object({
    dataTypes: z.array(PublicImportCategoryProgressSchema),
    warnings: z.array(z.string()),
  })
  .strict();
const SensitiveImportDataTypesSchema = z
  .array(BrowserSensitiveImportDataTypeSchema)
  .min(1)
  .max(3)
  .refine((dataTypes) => new Set(dataTypes).size === dataTypes.length, {
    message: "Sensitive browser import data types must be unique",
  });
const SensitiveImportCountSchema = z
  .object({
    dataType: BrowserSensitiveImportDataTypeSchema,
    read: z.number().int().nonnegative(),
    stored: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
  })
  .strict();
const SensitiveImportStatusSchema = z
  .object({
    operationId: z.string().min(1).max(200),
    state: z.enum(["running", "complete", "cancelled", "failed"]),
    counts: z.array(SensitiveImportCountSchema),
    error: z.string().optional(),
  })
  .strict();
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
    dataType: BrowserPublicImportDataTypeSchema,
    batchIndex: z.number().int().nonnegative(),
    items: z.array(z.unknown()),
  }),
  z.object({ type: z.literal("progress"), progress: PublicImportCategoryProgressSchema }),
  z.object({ type: z.literal("complete"), summary: PublicImportSummarySchema }),
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
      description: "Check which browser can provide data for import.",
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
      description: "Find browser profiles that have data you can import.",
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
      description: "Preview what browser data is available before importing it.",
      group: "network",
      authorityCategory: { domain: "web", verb: "see" },
    }),
  },
  previewSensitiveImport: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "browserEnvironment.control",
      rationale:
        "Returns aggregate review counts for protected browser categories without returning records or values.",
    },
    description: "Preview selected sensitive browser categories using aggregate counts only.",
    args: z.tuple([z.string().min(1), SensitiveImportDataTypesSchema]),
    returns: ImportSummarySchema.extend({
      breakdowns: z.array(ImportCategoryBreakdownSchema),
      openTabCount: z.number().int().nonnegative(),
      localDataSetCount: z.number().int().nonnegative(),
    }),
    access: { sensitivity: "read" },
    ...reviewedProviderAuthority,
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
    description: "Start a bounded, cancellable read of non-sensitive browser data.",
    args: z.tuple([z.string().min(1), z.array(BrowserPublicImportDataTypeSchema).min(1)]),
    returns: z.string().min(1),
    access: { sensitivity: "read" },
    ...brokerPolicy("startImportRead", {
      title: "Read browser data for import",
      action: "read browser data for import",
      description: "Read the browser data you selected for import.",
      group: "network",
      authorityCategory: { domain: "web", verb: "see" },
    }),
  },
  startSensitiveImport: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "browserEnvironment.create",
      rationale:
        "Runs credential-bearing browser import entirely in the trusted host and returns aggregate counts only; gated by authority principals.",
    },
    description:
      "Import selected sensitive browser data directly into the host vault without exposing plaintext frames.",
    args: z.tuple([z.string().min(1), SensitiveImportDataTypesSchema, z.string().min(1).max(200)]),
    returns: SensitiveImportStatusSchema,
    access: { sensitivity: "write" },
    ...reviewedProviderAuthority,
  },
  observeSensitiveImport: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "browserEnvironment.read",
      rationale: "Reads aggregate progress from the durable host import ledger.",
    },
    description: "Observe aggregate progress or the terminal receipt for a sensitive import.",
    args: z.tuple([z.string().min(1).max(200)]),
    returns: SensitiveImportStatusSchema,
    access: { sensitivity: "read" },
    ...reviewedProviderAuthority,
  },
  cancelSensitiveImport: {
    tier: {
      tier: "open",
      session: "family",
      residency: "native-effect",
      family: "browserEnvironment.retire",
      rationale: "Records durable cancellation and stops the active host import reader.",
    },
    description: "Cancel a sensitive import and return its durable terminal status.",
    args: z.tuple([z.string().min(1).max(200)]),
    returns: SensitiveImportStatusSchema,
    access: { sensitivity: "write" },
    ...reviewedProviderAuthority,
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
      description: "Continue reading browser data during an import.",
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
      description: "Stop an in-progress browser data import.",
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
      description: "See which browser tabs can be imported.",
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
      description: "See your current and recent browser downloads.",
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
      description: "Pause downloads that are currently in progress.",
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
      description: "Resume downloads that were paused.",
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
      description: "Cancel downloads that are currently in progress.",
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
      description: "Open a downloaded file on this computer.",
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
      description: "Show a downloaded file in your file manager.",
      group: "network",
      authorityCategory: { domain: "computer", verb: "act" },
    }),
  },
});

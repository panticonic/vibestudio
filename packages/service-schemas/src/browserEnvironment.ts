import { z } from "zod";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";
import {
  BrowserImportDataTypeSchema,
  BrowserImportSourceSchema,
  ImportCategoryProgressSchema,
  ImportHostSummarySchema,
} from "@vibestudio/browser-data";
import { requirementForPrincipals } from "@vibestudio/shared/authorization";

export const BROWSER_ENVIRONMENT_BROKER_AUTHORITY_PREFIX =
  "browserEnvironment.broker";

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
          requirement: { kind: "selected" as const, principals: ["code" as const] },
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

const ImportedOpenTabSchema = z.object({
  tabId: z.string(),
  url: z.string().url(),
  title: z.string().optional(),
  active: z.boolean(),
  pinned: z.boolean().optional(),
  lastAccessed: z.number().optional(),
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
    description: "Describe the trusted browser-import provider on this host.",
    args: z.tuple([]),
    returns: ImportHostSummarySchema,
    access: { sensitivity: "read" },
    authority: brokerAuthority("getImportHost"),
  },
  listImportSources: {
    description: "List opaque browser sources discoverable by this trusted host.",
    args: z.tuple([]),
    returns: z.array(BrowserImportSourceSchema),
    access: { sensitivity: "read" },
    authority: brokerAuthority("listImportSources"),
  },
  previewImportSource: {
    description: "Preview normalized import counts without exposing browser secrets.",
    args: z.tuple([z.string().min(1), z.array(BrowserImportDataTypeSchema).min(1)]),
    returns: ImportSummarySchema.extend({
      openTabCount: z.number().int().nonnegative(),
      localDataSetCount: z.number().int().nonnegative(),
    }),
    access: { sensitivity: "read" },
    authority: brokerAuthority("previewImportSource"),
  },
  startImportRead: {
    description: "Start a bounded, cancellable read from an opaque browser source.",
    args: z.tuple([z.string().min(1), z.array(BrowserImportDataTypeSchema).min(1)]),
    returns: z.string().min(1),
    access: { sensitivity: "read" },
    authority: brokerAuthority("startImportRead"),
  },
  nextImportFrame: {
    description: "Read the next bounded progress or data frame from an import operation.",
    args: z.tuple([z.string().min(1)]),
    returns: ImportProviderFrameSchema,
    access: { sensitivity: "read" },
    authority: brokerAuthority("nextImportFrame"),
  },
  cancelImportRead: {
    description: "Cancel an active trusted-host browser import read.",
    args: z.tuple([z.string().min(1)]),
    returns: z.void(),
    access: { sensitivity: "write" },
    authority: brokerAuthority("cancelImportRead"),
  },
  listImportOpenTabs: {
    description: "List importable HTTP(S) tabs without exposing source filesystem paths.",
    args: z.tuple([z.string().min(1)]),
    returns: z.array(ImportedOpenTabSchema),
    access: { sensitivity: "read" },
    authority: brokerAuthority("listImportOpenTabs"),
  },
  flushCookieProjection: {
    description: "Flush local cookie changes and reconcile the canonical browser jar.",
    args: z.tuple([z.array(z.string().url()).max(50)]),
    returns: z.object({ revision: z.number().int().nonnegative() }),
    access: { sensitivity: "write" },
    authority: brokerAuthority("flushCookieProjection"),
  },
  getCookieProjectionDiagnostics: {
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
    description: "List current and recent downloads for this browser host.",
    args: z.tuple([]),
    returns: z.array(DownloadRecordSchema),
    access: { sensitivity: "read" },
    authority: brokerAuthority("listDownloads"),
  },
  pauseDownload: {
    description: "Pause an active browser download.",
    args: z.tuple([z.string()]),
    returns: z.void(),
    access: { sensitivity: "write" },
    authority: brokerAuthority("pauseDownload"),
  },
  resumeDownload: {
    description: "Resume a paused browser download.",
    args: z.tuple([z.string()]),
    returns: z.void(),
    access: { sensitivity: "write" },
    authority: brokerAuthority("resumeDownload"),
  },
  cancelDownload: {
    description: "Cancel an active browser download.",
    args: z.tuple([z.string()]),
    returns: z.void(),
    access: { sensitivity: "destructive" },
    authority: brokerAuthority("cancelDownload"),
  },
  openDownload: {
    description: "Open a completed browser download with the operating system.",
    args: z.tuple([z.string()]),
    returns: z.void(),
    access: { sensitivity: "write" },
    authority: brokerAuthority("openDownload"),
  },
  revealDownload: {
    description: "Reveal a browser download in the operating system file manager.",
    args: z.tuple([z.string()]),
    returns: z.void(),
    access: { sensitivity: "write" },
    authority: brokerAuthority("revealDownload"),
  },
});

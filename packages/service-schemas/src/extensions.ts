/**
 * Wire schema for the "extensions" management/invocation service
 * (served by packages/extension-host).
 */

import { z } from "zod";
import type { MethodAccessDescriptor } from "@vibestudio/shared/serviceAuthority";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";
import { JsonValueSchema } from "@vibestudio/shared/wireValues";

// Access descriptors add documentation and safety metadata. Enforced
// caller-kind gates live in the method/service policy.
const READ_ACCESS: MethodAccessDescriptor = {
  sensitivity: "read",
};
const INVOKE_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};
const EXTENSION_REPORT_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};
const STREAM_ACCESS: MethodAccessDescriptor = {
  sensitivity: "write",
};
const ADMIN_RELOAD_ACCESS: MethodAccessDescriptor = {
  sensitivity: "admin",
};

export const extensionRegistryEntrySchema = z
  .object({
    unitKind: z.literal("extension"),
    name: z.string(),
    shortName: z
      .string()
      .describe("Unscoped workspace name (for example test-runner); name remains canonical."),
    version: z.string(),
    source: z
      .object({
        kind: z.literal("workspace-repo"),
        repo: z.string(),
        ref: z.string(),
      })
      .strict(),
    installedAt: z.number(),
    activeEv: z.string().nullable(),
    activeSourceHash: z.string().nullable(),
    activeBundleKey: z.string().nullable(),
    activeDependencyEvs: z.record(z.string()),
    activeExternalDeps: z.record(z.string()),
    activeRuntimeDepsKey: z.string().nullable(),
    status: z.enum(["running", "available", "stopped", "error", "pending-approval", "building"]),
    lastError: z.string().nullable(),
  })
  .strict();

export const binaryEnvelopeSchema = z
  .object({
    __bin: z.literal(true),
    data: z.string(),
  })
  .strict();

export const streamChunkEnvelopeSchema = z
  .object({
    done: z.boolean(),
    chunk: binaryEnvelopeSchema.optional(),
  })
  .strict();

export const extensionProviderMethodsSchema = z.record(z.array(z.string()));

export const extensionsMethods = defineServiceMethods({
  invoke: {
    description:
      "Invoke a public method on a running installed extension and await its result. Provider-namespaced methods are rejected.",
    args: z.tuple([z.string(), z.string(), z.array(z.unknown())]),
    returns: JsonValueSchema,
    access: INVOKE_ACCESS,
    examples: [{ args: ["shell", "exec", [{ command: "echo hi" }]] }],
  },
  invokeProvider: {
    description:
      "Invoke a provider-namespaced method on the extension declared for a manifest provider slot. Host-owned provider contracts must be called through their owning host service.",
    args: z.tuple([z.string(), z.string(), z.array(z.unknown())]),
    returns: JsonValueSchema,
    access: INVOKE_ACCESS,
    examples: [{ args: ["claudeCode", "prepare", [{ channelId: "chan_123" }]] }],
  },
  // invokeStream intentionally declares no return schema: the result is a raw
  // streaming Response, not a wire-serializable value.
  invokeStream: {
    description:
      "Invoke a public streaming method on a running extension; the host proxies its byte stream back. Provider-namespaced methods are rejected.",
    args: z.tuple([z.string(), z.string(), z.array(z.unknown())]),
    access: INVOKE_ACCESS,
  },
  streamingMethods: {
    description:
      "List the method names an extension's manifest declares as streaming, so callers route them through invokeStream. Unknown extensions return an empty list.",
    args: z.tuple([z.string()]),
    returns: z.array(z.string()),
    access: READ_ACCESS,
    examples: [{ args: ["shell"] }],
  },
  list: {
    description:
      "List installed extensions with canonical package name, shortName, source repo, and runtime status. Invoke accepts the canonical name, shortName, or source repo.",
    args: z.tuple([]),
    returns: z.array(extensionRegistryEntrySchema),
    access: READ_ACCESS,
  },
  ready: {
    description:
      "Extension-only: signal that the child process has finished startup and is ready to serve, declaring its public methods, provider-namespaced methods, and whether it handles fetch.",
    args: z.tuple([
      z
        .object({
          methods: z.array(z.string()).describe("Public method names exposed through invoke."),
          providerMethods: extensionProviderMethodsSchema.describe(
            "Method names exposed under each declared provider namespace."
          ),
          hasFetch: z
            .boolean()
            .describe("Whether the extension handles HTTP fetch requests routed to it."),
        })
        .strict(),
    ]),
    returns: z.null(),
    access: EXTENSION_REPORT_ACCESS,
    examples: [{ args: [{ methods: ["exec"], providerMethods: {}, hasFetch: false }] }],
  },
  emit: {
    description:
      "Extension-only: emit a named event (with payload) to subscribers of this extension. Rejected for non-extension callers.",
    args: z.tuple([z.string(), z.unknown()]),
    returns: z.null(),
    access: EXTENSION_REPORT_ACCESS,
  },
  fetchRequestBodyChunk: {
    description:
      "Extension-only: pull the next chunk of a proxied HTTP request body stream by stream id (advances the stream cursor).",
    args: z.tuple([z.string()]),
    returns: streamChunkEnvelopeSchema,
    access: STREAM_ACCESS,
  },
  fetchRequestBodyClose: {
    description:
      "Extension-only: close and release a proxied HTTP request body stream by id. No-op if the stream is already gone.",
    args: z.tuple([z.string()]),
    returns: z.null(),
    access: STREAM_ACCESS,
  },
  health: {
    description:
      "Extension-only: report the extension's current health state with optional summary/reasons/retry detail.",
    args: z.tuple([z.enum(["healthy", "degraded", "unhealthy"]), z.unknown().optional()]),
    returns: z.null(),
    access: EXTENSION_REPORT_ACCESS,
  },
  log: {
    description: "Extension-only: write a structured log record (level, message, optional fields).",
    args: z.union([
      z.tuple([z.enum(["debug", "info", "warn", "error"]), z.string()]),
      z.tuple([z.enum(["debug", "info", "warn", "error"]), z.string(), z.record(z.unknown())]),
    ]),
    returns: z.null(),
    access: EXTENSION_REPORT_ACCESS,
  },
  reload: {
    description:
      "Rebuild and restart an extension from its active approved build. Approval-gated for panel/app/worker/do callers; shell callers are pre-authorized.",
    args: z.tuple([z.string()]),
    returns: z.void(),
    access: ADMIN_RELOAD_ACCESS,
    examples: [{ args: ["shell"] }],
  },
});

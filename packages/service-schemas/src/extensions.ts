/**
 * Wire schema for the "extensions" management/invocation service
 * (served by packages/extension-host).
 */

import { z } from "zod";
import type { MethodAccessDescriptor } from "@vibestudio/shared/serviceAuthority";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";
import { selectedPreparedAuthorityRequirement } from "@vibestudio/shared/typedServiceClient";
import { requirementForPrincipals } from "@vibestudio/shared/authorityRequirements";
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

export const EXTENSION_METHOD_AUTHORITY_RESOLVER = "extensions.invoke.userland-method";
const extensionInvocationAuthority = {
  requirement: requirementForPrincipals(["code", "user", "host", "website"], "service:extensions.invoke"),
  resource: { kind: "literal" as const, key: "service:extensions.invoke" },
  prepared: {
    resolver: EXTENSION_METHOD_AUTHORITY_RESOLVER,
    leaves: [
      {
        capabilityPrefix: "userland:",
        requirement: selectedPreparedAuthorityRequirement(["code", "user", "host", "website"]),
        tier: { selectedFrom: ["gated", "critical"] as const },
      },
    ],
  },
};

/** Bounded proof that a real extension transport call completed; never carries application values. */
const extensionInvocationResultShapeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("array"), length: z.number().int().nonnegative() }).strict(),
  z.object({ kind: z.literal("object"), keyCount: z.number().int().nonnegative() }).strict(),
  z.object({ kind: z.literal("string"), length: z.number().int().nonnegative() }).strict(),
  z.object({ kind: z.literal("number") }).strict(),
  z.object({ kind: z.literal("boolean") }).strict(),
  z.object({ kind: z.literal("null") }).strict(),
]);
const extensionInvocationObservationFields = {
  protocol: z.literal("extension-invocation-observation.v1"),
  method: z.string().min(1),
  result: extensionInvocationResultShapeSchema,
};
export const NativeExtensionInvocationObservationSchema = z.discriminatedUnion("transport", [
  z
    .object({
      ...extensionInvocationObservationFields,
      transport: z.literal("invoke"),
      extensionKey: z.string().min(1),
    })
    .strict(),
  z
    .object({
      ...extensionInvocationObservationFields,
      transport: z.literal("invokeProvider"),
      providerKey: z.string().min(1),
    })
    .strict(),
]);
export type NativeExtensionInvocationObservation = z.infer<
  typeof NativeExtensionInvocationObservationSchema
>;

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

const publicExtensionInvocationArgs = z.tuple([
  z.string().describe(
    "Extension identity: prefer the canonical package name from build.listUnits entries with kind extension. The source path and its exact final segment are also accepted. A display title or guessed abbreviation is not an identifier.",
  ),
  z.string().describe("Public method declared by that extension's methodAuthority; use its API contract for the positional arguments."),
  z.array(z.unknown()).describe("Positional arguments to the selected extension method."),
]);

export const extensionsMethods = defineServiceMethods({
  invoke: {
    website: { kind: "eligible", rationale: "The host resolves and enforces the exact sealed extension method policy before invocation." },
    tier: {
      tier: "open",
      session: "family",
      residency: "transport",
      family: "extensions.control",
      rationale:
        "Invocation is limited to an installed, approved extension and preserves the admitted caller and execution-session context; the extension's own sensitive operations remain authority-checked",
    },
    description:
      "Invoke a public method on a declared, approved extension and await its result. Discover canonical extension names with build.listUnits; the invocation boundary builds and activates cold onInvoke extensions. Provider-namespaced methods are rejected.",
    args: publicExtensionInvocationArgs,
    argumentNames: ["extension", "method", "args"],
    returns: JsonValueSchema,
    access: INVOKE_ACCESS,
    authority: extensionInvocationAuthority,
    examples: [
      {
        args: ["shell", "list", []],
      },
    ],
  },
  invokeProvider: {
    website: {"kind":"closed","reason":"The extensions receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations."} as const,
    tier: {
      tier: "open",
      session: "family",
      residency: "transport",
      family: "extensions.control",
      rationale:
        "Provider routing preserves the admitted caller and execution-session context; the selected provider's operation remains independently authority-checked",
    },
    description:
      "Invoke a public provider-namespaced method on the extension selected for a manifest provider slot. Provider methods explicitly marked private are unavailable through this route.",
    args: z.tuple([z.string(), z.string(), z.array(z.unknown())]),
    returns: JsonValueSchema,
    // Dispatch is read-only; the host checks the selected provider method’s canonical access.
    access: READ_ACCESS,
    examples: [{ args: ["gitInterop", "prepare", [{ channelId: "chan_123" }]] }],
  },
  // invokeStream intentionally declares no return schema: the result is a raw
  // streaming Response, not a wire-serializable value.
  invokeStream: {
    website: {"kind":"closed","reason":"The extensions receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations."} as const,
    tier: {
      tier: "open",
      session: "family",
      residency: "transport",
      family: "extensions.control",
      rationale:
        "Streaming invocation has the same installed-extension boundary and caller propagation as unary invocation",
    },
    description:
      "Invoke a public streaming method on a running extension; the host proxies its byte stream back. Provider-namespaced methods are rejected.",
    args: publicExtensionInvocationArgs,
    argumentNames: ["extension", "method", "args"],
    access: INVOKE_ACCESS,
  },
  streamingMethods: {
    website: {"kind":"closed","reason":"The extensions receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations."} as const,
    tier: {
      tier: "open",
      session: "family",
      residency: "transport",
      family: "extensions.control",
      rationale:
        "Streaming-method discovery is required by the extension invocation router and shares its admitted execution-session scope; it returns manifest metadata and grants no invocation authority",
    },
    description:
      "List the method names an extension's manifest declares as streaming, so callers route them through invokeStream. Unknown extensions return an empty list.",
    args: z.tuple([z.string()]),
    returns: z.array(z.string()),
    access: READ_ACCESS,
    examples: [{ args: ["shell"] }],
  },
  emit: {
    website: {"kind":"closed","reason":"The extensions receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations."} as const,
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "transport",
      family: "extensions.control",
      rationale:
        "Open bias: no C1-C4 or G1-G5 rule applies; §2 durable code identity or host approval plumbing",
    },
    description:
      "Extension-only: emit a named event (with payload) to subscribers of this extension. Rejected for non-extension callers.",
    args: z.tuple([z.string(), z.unknown()]),
    returns: z.null(),
    access: EXTENSION_REPORT_ACCESS,
  },
  fetchRequestBodyChunk: {
    website: {"kind":"closed","reason":"The extensions receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations."} as const,
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "transport",
      family: "extensions.control",
      rationale:
        "Open bias: no C1-C4 or G1-G5 rule applies; §2 durable code identity or host approval plumbing",
    },
    description:
      "Extension-only: pull the next chunk of a proxied HTTP request body stream by stream id (advances the stream cursor).",
    args: z.tuple([z.string()]),
    returns: streamChunkEnvelopeSchema,
    access: STREAM_ACCESS,
    authority: extensionInvocationAuthority,
  },
  fetchRequestBodyClose: {
    website: {"kind":"closed","reason":"The extensions receiver controls workspace implementation or trusted host UI; websites use its reviewed public operations."} as const,
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "transport",
      family: "extensions.control",
      rationale:
        "Open bias: no C1-C4 or G1-G5 rule applies; §2 durable code identity or host approval plumbing",
    },
    description:
      "Extension-only: close and release a proxied HTTP request body stream by id. No-op if the stream is already gone.",
    args: z.tuple([z.string()]),
    returns: z.null(),
    access: STREAM_ACCESS,
  },
});

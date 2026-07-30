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
  requirement: requirementForPrincipals(["code", "user", "host"], "service:extensions.invoke"),
  resource: { kind: "literal" as const, key: "service:extensions.invoke" },
  prepared: {
    resolver: EXTENSION_METHOD_AUTHORITY_RESOLVER,
    leaves: [
      {
        capabilityPrefix: "userland:",
        requirement: selectedPreparedAuthorityRequirement(["code", "user", "host"]),
        tier: { selectedFrom: ["gated", "critical"] as const },
      },
    ],
  },
};

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

export const extensionsMethods = defineServiceMethods({
  invoke: {
    tier: {
      tier: "open",
      session: "family",
      residency: "transport",
      family: "extensions.control",
      rationale:
        "Invocation is limited to an installed, approved extension and preserves the admitted caller and execution-session context; the extension's own sensitive operations remain authority-checked",
    },
    description:
      "Invoke a public method on a running installed extension and await its result. Provider-namespaced methods are rejected.",
    args: z.tuple([z.string(), z.string(), z.array(z.unknown())]),
    returns: JsonValueSchema,
    access: INVOKE_ACCESS,
    authority: extensionInvocationAuthority,
    examples: [
      {
        args: ["shell", "exec", [{ intent: { kind: "argv", executable: "echo", args: ["hi"] } }]],
      },
    ],
  },
  invokeProvider: {
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
    access: INVOKE_ACCESS,
    examples: [{ args: ["claudeCode", "prepare", [{ channelId: "chan_123" }]] }],
  },
  // invokeStream intentionally declares no return schema: the result is a raw
  // streaming Response, not a wire-serializable value.
  invokeStream: {
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
    args: z.tuple([z.string(), z.string(), z.array(z.unknown())]),
    access: INVOKE_ACCESS,
  },
  streamingMethods: {
    tier: {
      tier: "open",
      session: "codeOnly",
      residency: "transport",
      family: "extensions.control",
      rationale:
        "Open bias: no C1-C4 or G1-G5 rule applies; §2 durable code identity or host approval plumbing",
    },
    description:
      "List the method names an extension's manifest declares as streaming, so callers route them through invokeStream. Unknown extensions return an empty list.",
    args: z.tuple([z.string()]),
    returns: z.array(z.string()),
    access: READ_ACCESS,
    examples: [{ args: ["shell"] }],
  },
  emit: {
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

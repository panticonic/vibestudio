/** Canonical streamed workspace gateway contract, shared by host and clients. */
import { z } from "zod";
import { defineServiceMethods } from "@vibestudio/shared/typedServiceClient";
import { StreamResponseSchema } from "@vibestudio/shared/streamResponse";

// STRICT: a caller still sending the deleted base64/plain-string body fields
// (`body`/`bodyBase64`) must fail loudly, not have its body silently stripped.
const fetchDescriptorSchema = z
  .object({
    /** Absolute gateway path, for example `/apps/shell/?contextId=…`. */
    path: z.string(),
    method: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    // Gzip the response on the wire. Mobile receives bounded QUIC chunks through
    // receive (one message per round-trip), so a multi-MB asset streams too slowly
    // over a relay; gzip (~4×) keeps it inside the pipe window. The caller is
    // responsible for decompressing (the mobile native host does, before verifying
    // the *uncompressed* integrity). Signaled back via `x-vibestudio-content-gzip`.
    gzip: z.boolean().optional(),
  })
  .strict();

/** Request bodies ride the transport stream and never enter this descriptor. */
export type GatewayFetchDescriptor = z.infer<typeof fetchDescriptorSchema>;

export const gatewayMethods = defineServiceMethods({
  fetch: {
    capability: "workspace.gateway.access",
    tier: {
      tier: "gated",
      session: "family",
      residency: "transport",
      family: "gateway.control",
      rationale:
        "G1: external-system effect or listening surface; §2 default {code, session} family",
    },
    presentation: {
      title: "Access a workspace gateway address",
      action: "access a workspace gateway address",
      description: "Allows {requesterKind} to access a workspace gateway address.",
      group: "network",
      authorityCategory: {
        domain: "web",
        verb: "see",
      },
    },
    description:
      "Loopback-fetch a panel asset from the server's own gateway and stream the " +
      "Response back over a dedicated transport stream. A request " +
      "body streams IN over the same channel (stream-open bodyStreamId → ctx.body).",
    args: z.tuple([fetchDescriptorSchema]),
    // Streaming method: the handler returns a Response whose body is chunked
    // through the transport's streaming handler. Node callers use `.stream`
    // (Response); RN callers use `.streamReadable` (the raw ReadableStream).
    returns: StreamResponseSchema,
    access: { sensitivity: "read" as const },
  },
});

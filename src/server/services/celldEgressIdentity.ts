/**
 * The identity celld stamps on every outbound request of every isolate, and
 * the verification of its MAC (celld docs/services/egress.md).
 *
 * Three headers reach the egress proxy: the identity (base64url JSON), a
 * nonce and an HMAC-SHA256 over the request. Nothing in the identity is
 * trusted until the MAC has verified; the MAC covers the traffic kind, the
 * method, the request-line target exactly as received, the identity bytes
 * as received and the nonce. This module is the only place that reads them.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

export const CELLD_EGRESS_IDENTITY_HEADER = "x-celld-egress-identity";
export const CELLD_EGRESS_NONCE_HEADER = "x-celld-egress-nonce";
export const CELLD_EGRESS_MAC_HEADER = "x-celld-egress-mac";

/** Headers the proxy consumes; stripped before anything is forwarded. */
export const CELLD_EGRESS_HEADERS: readonly string[] = [
  CELLD_EGRESS_IDENTITY_HEADER,
  CELLD_EGRESS_NONCE_HEADER,
  CELLD_EGRESS_MAC_HEADER,
];

/** Which kind of outbound traffic a request is (part of the MAC input). */
export type CelldEgressKind = "fetch" | "websocket" | "connect";

export interface CelldEgressIdentity {
  readonly v: 1;
  /** Deployment version string that holds the isolate. */
  readonly deployment: string;
  /** Deployed script (the root of a loader chain for a loaded worker). */
  readonly script: string;
  /** True for a dynamic worker (Worker Loader code). */
  readonly loaded: boolean;
  /** Durable Object class of the running event, null in a plain fetch handler. */
  readonly class: string | null;
  readonly cell: string | null;
  readonly root: string | null;
  /** `celld: { egressIdentity }` strings of the loaders, outermost first. */
  readonly egressIdentity: readonly string[];
}

/** The product's internal Durable Object source (its classes' bearer namespace). */
export const INTERNAL_EGRESS_SOURCE = "vibestudio/internal";
/** The host program class that hosts userland Durable Objects. */
const UNIVERSAL_DO_CLASS = "UniversalDO";

/**
 * Who a verified identity speaks for:
 * - `caller`: a principal the host registered, keyed by its caller id. A loaded
 *   worker speaks as the identity its loader chose (`egressIdentity[0]`); a
 *   product Durable Object class as its service principal.
 * - `host-program`: the runtime application's own router, worker host or
 *   UniversalDO (no class, or UniversalDO, and not loaded). Its traffic is
 *   confined to the gateway origin by the proxy.
 */
export type CelldEgressSubject =
  | { readonly kind: "caller"; readonly callerId: string }
  | { readonly kind: "host-program" };

export function celldEgressSubject(identity: CelldEgressIdentity): CelldEgressSubject | null {
  if (identity.loaded) {
    const first = identity.egressIdentity[0];
    return first ? { kind: "caller", callerId: first } : null;
  }
  if (identity.class === null || identity.class === UNIVERSAL_DO_CLASS) {
    return { kind: "host-program" };
  }
  return { kind: "caller", callerId: `do-service:${INTERNAL_EGRESS_SOURCE}:${identity.class}` };
}

function macInput(
  kind: CelldEgressKind,
  method: string,
  target: string,
  identity: string,
  nonce: string
): string {
  return `celld-egress/v1\n${kind}\n${method}\n${target}\n${identity}\n${nonce}\n`;
}

function header(headers: IncomingHttpHeaders, name: string): string | null {
  const value = headers[name];
  const text = Array.isArray(value) ? value[0] : value;
  return typeof text === "string" && text.length > 0 ? text : null;
}

function parseIdentity(raw: string): CelldEgressIdentity | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const value = parsed as Record<string, unknown>;
  if (
    value["v"] !== 1 ||
    typeof value["deployment"] !== "string" ||
    typeof value["script"] !== "string" ||
    typeof value["loaded"] !== "boolean" ||
    !(value["class"] === null || typeof value["class"] === "string") ||
    !(value["cell"] === null || typeof value["cell"] === "string") ||
    !(value["root"] === null || typeof value["root"] === "string") ||
    !Array.isArray(value["egressIdentity"]) ||
    !value["egressIdentity"].every((entry) => typeof entry === "string")
  ) {
    return null;
  }
  return value as unknown as CelldEgressIdentity;
}

/**
 * Verify the MAC of a request and decode its identity. `method` and `target`
 * are the request line as Node received it (the absolute URL for fetch and
 * WebSocket, `host:port` for connect); do not substitute the Host header or a
 * parsed URL.
 */
export function verifyCelldEgress(input: {
  readonly headers: IncomingHttpHeaders;
  readonly kind: CelldEgressKind;
  readonly method: string;
  readonly target: string;
  readonly secret: string;
}): CelldEgressIdentity | null {
  const identity = header(input.headers, CELLD_EGRESS_IDENTITY_HEADER);
  const nonce = header(input.headers, CELLD_EGRESS_NONCE_HEADER);
  const mac = header(input.headers, CELLD_EGRESS_MAC_HEADER);
  if (!identity || !nonce || !mac) return null;
  const supplied = Buffer.from(mac, "base64url");
  const expected = createHmac("sha256", input.secret)
    .update(macInput(input.kind, input.method, input.target, identity, nonce))
    .digest();
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;
  return parseIdentity(identity);
}

/** Stamp a request as the node does. Used by tests and fixtures. */
export function signCelldEgress(input: {
  readonly secret: string;
  readonly kind: CelldEgressKind;
  readonly method: string;
  readonly target: string;
  readonly identity: Partial<CelldEgressIdentity> & { readonly loaded: boolean };
  readonly nonce?: string;
}): Record<string, string> {
  const identity: CelldEgressIdentity = {
    v: 1,
    deployment: "test-deployment",
    script: "vibestudio",
    class: null,
    cell: null,
    root: null,
    egressIdentity: [],
    ...input.identity,
  };
  const encoded = Buffer.from(JSON.stringify(identity)).toString("base64url");
  const nonce = input.nonce ?? Buffer.from("0123456789abcdef").toString("base64url");
  const mac = createHmac("sha256", input.secret)
    .update(macInput(input.kind, input.method, input.target, encoded, nonce))
    .digest("base64url");
  return {
    [CELLD_EGRESS_IDENTITY_HEADER]: encoded,
    [CELLD_EGRESS_NONCE_HEADER]: nonce,
    [CELLD_EGRESS_MAC_HEADER]: mac,
  };
}

import { isValidClientId, isValidIntentName } from "@vibestudio/workspace-contracts/clients";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import { clientsMethods } from "@vibestudio/service-schemas/clients";
import type { HostDescriptor } from "@vibestudio/workspace-contracts/clients";
import type { Call } from "./launch.js";

export interface ClientIntentRequest {
  id: string;
  intent: string;
  params: Record<string, string>;
}

export type IntentLinkErrorCode =
  | "not-client-link"
  | "malformed-link"
  | "invalid-client-id"
  | "invalid-intent"
  | "invalid-params";

export class IntentLinkError extends Error {
  constructor(
    readonly code: IntentLinkErrorCode,
    message: string
  ) {
    super(message);
    this.name = "IntentLinkError";
  }
}

const MAX_PARAM_KEY = 64;
const MAX_PARAM_VALUE = 65_536;

// `vibestudio://c/<id>/<intent>?<params>` and `https://vibestudio.app/c/<id>/<intent>#<params>`.
const CUSTOM = /^vibestudio:\/\/c\/([^/?#]*)\/([^/?#]*)(?:\?([^#]*))?$/iu;
const WEB = /^https:\/\/vibestudio\.app\/c\/([^/?#]*)\/([^/?#]*)(?:#(.*))?$/iu;
const CLIENT_PREFIX = /^(?:vibestudio:\/\/c(?:\/|$)|https:\/\/vibestudio\.app\/c(?:\/|$))/iu;

function decodePart(value: string, what: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/gu, " "));
  } catch {
    throw new IntentLinkError("invalid-params", `Malformed percent-encoding in ${what}`);
  }
}

function parseParams(raw: string | undefined): Record<string, string> {
  const params: Record<string, string> = Object.create(null) as Record<string, string>;
  if (!raw) return params;
  for (const pair of raw.split("&")) {
    if (pair === "") continue;
    const eq = pair.indexOf("=");
    const key = decodePart(eq < 0 ? pair : pair.slice(0, eq), "a parameter name");
    const value = decodePart(eq < 0 ? "" : pair.slice(eq + 1), `parameter "${key}"`);
    if (key.length === 0 || key.length > MAX_PARAM_KEY) {
      throw new IntentLinkError("invalid-params", "Parameter name is empty or too long");
    }
    if (value.length > MAX_PARAM_VALUE) {
      throw new IntentLinkError("invalid-params", `Parameter "${key}" is too long`);
    }
    if (key in params) {
      throw new IntentLinkError("invalid-params", `Parameter "${key}" is repeated`);
    }
    params[key] = value;
  }
  return { ...params };
}

/** True when the link is in the client grammar (valid or not); other links belong to other handlers. */
export function isClientLink(link: string): boolean {
  return CLIENT_PREFIX.test(link);
}

export function parseClientIntentLink(link: string): ClientIntentRequest {
  if (!isClientLink(link)) {
    throw new IntentLinkError("not-client-link", "Not a client link");
  }
  const match = CUSTOM.exec(link) ?? WEB.exec(link);
  if (!match) throw new IntentLinkError("malformed-link", "Client link must name a client and an intent");
  const [, id, intent, rawParams] = match;
  if (!isValidClientId(id)) {
    throw new IntentLinkError("invalid-client-id", `Invalid client id: ${id}`);
  }
  if (!isValidIntentName(intent)) {
    throw new IntentLinkError("invalid-intent", `Invalid intent name: ${intent}`);
  }
  return { id, intent, params: parseParams(rawParams) };
}

/** Run a background intent server-side (§4.7.2); the result is declared by the client's manifest. */
export async function invokeBackgroundIntent(
  call: Call,
  descriptor: HostDescriptor,
  request: ClientIntentRequest
) {
  const clients = createTypedServiceClient("clients", clientsMethods, call);
  return clients.invokeIntent(descriptor, {
    id: request.id,
    intent: request.intent,
    ...(Object.keys(request.params).length > 0 ? { params: request.params } : {}),
  });
}

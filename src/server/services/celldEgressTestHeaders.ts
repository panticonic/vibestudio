import { signCelldEgress, type CelldEgressKind } from "./celldEgressIdentity.js";

/**
 * Test fixtures say which caller sends a request and under which secret
 * (`X-Vibestudio-Egress-Caller`, `X-Vibestudio-Egress-Secret`). The node
 * proves it with an identity and a MAC over the request line; this turns the
 * fixture's words into exactly that, so the proxy is exercised through the
 * real verification (a wrong secret is a wrong MAC).
 */
export function attributeAsNode(
  headers: Record<string, string>,
  kind: CelldEgressKind,
  method: string,
  target: string
): Record<string, string> {
  const result: Record<string, string> = {};
  let caller: string | undefined;
  let secret: string | undefined;
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower === "x-vibestudio-egress-caller") caller = value;
    else if (lower === "x-vibestudio-egress-secret") secret = value;
    else result[name] = value;
  }
  if (caller === undefined || secret === undefined) return result;
  return {
    ...result,
    ...signCelldEgress({
      secret,
      kind,
      method,
      target,
      identity: { loaded: true, egressIdentity: [caller] },
    }),
  };
}

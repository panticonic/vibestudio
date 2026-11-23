import { CDP_INTERNAL_GRANT_HEADER } from "@vibestudio/shared/cdpGrants";
import { WORKERD_INSPECTOR_PATH_PREFIX } from "./workerdInspectorBridge.js";

/** Only host-minted exact-target inspection grants cross the internal gateway.
 * Validation does not consume the token: the authenticated bridge handshake
 * redeems it once. The two bridges retain independent grant namespaces/stores.
 */
export function authorizeInspectionEgress(input: {
  targetUrl: URL; method: string; headers: Headers | Record<string,string|string[]|undefined>;
}, policy: {
  gatewayOrigin: string;
  validatesPanel(token: string,target: string): boolean;
  validatesWorkerd(token: string,target: string): boolean;
}): {trustedForwardHeaders:Record<string,string>} | null {
  if(input.targetUrl.origin!==policy.gatewayOrigin || input.method!=="GET" || input.targetUrl.username || input.targetUrl.password)return null;
  const raw=input.headers instanceof Headers ? input.headers.get(CDP_INTERNAL_GRANT_HEADER) :
    Object.entries(input.headers).find(([name])=>name.toLowerCase()===CDP_INTERNAL_GRANT_HEADER)?.[1];
  // Ambiguous duplicate grants are never reconstructed as authenticated input.
  if(typeof raw!=="string" || !raw)return null;
  let target:string;
  try {
    if(input.targetUrl.pathname.startsWith("/cdp/")){
      target=decodeURIComponent(input.targetUrl.pathname.slice("/cdp/".length));
      if(!target || !policy.validatesPanel(raw,target))return null;
    }else if(input.targetUrl.pathname.startsWith(WORKERD_INSPECTOR_PATH_PREFIX)){
      target=decodeURIComponent(input.targetUrl.pathname.slice(WORKERD_INSPECTOR_PATH_PREFIX.length));
      if(!target || !policy.validatesWorkerd(raw,target))return null;
    }else return null;
  }catch{return null;}
  return {trustedForwardHeaders:{[CDP_INTERNAL_GRANT_HEADER]:raw}};
}

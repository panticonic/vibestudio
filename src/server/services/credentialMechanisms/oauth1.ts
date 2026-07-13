import { createHmac, randomBytes } from "node:crypto";

export interface OAuth1AuthorizationParams {
  method: string;
  url: URL;
  consumerKey: string;
  consumerSecret: string;
  token?: string;
  tokenSecret?: string;
  extraOAuthParams?: Readonly<Record<string, string>>;
}

export function oauth1AuthorizationHeader(params: OAuth1AuthorizationParams): string {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: params.consumerKey,
    oauth_nonce: randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_version: "1.0",
    ...(params.token ? { oauth_token: params.token } : {}),
    ...(params.extraOAuthParams ?? {}),
  };
  const signatureParams = new URLSearchParams(params.url.search);
  for (const [key, value] of Object.entries(oauthParams)) {
    signatureParams.append(key, value);
  }
  const normalizedParams = Array.from(signatureParams.entries())
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey === rightKey ? leftValue.localeCompare(rightValue) : leftKey.localeCompare(rightKey)
    )
    .map(([key, value]) => `${oauthPercentEncode(key)}=${oauthPercentEncode(value)}`)
    .join("&");
  const baseUrl = new URL(params.url.toString());
  baseUrl.search = "";
  const signatureBase = [
    params.method.toUpperCase(),
    oauthPercentEncode(baseUrl.toString()),
    oauthPercentEncode(normalizedParams),
  ].join("&");
  const signingKey = `${oauthPercentEncode(params.consumerSecret)}&${oauthPercentEncode(params.tokenSecret ?? "")}`;
  oauthParams["oauth_signature"] = createHmacSha1(signingKey, signatureBase);
  return (
    "OAuth " +
    Object.entries(oauthParams)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => `${oauthPercentEncode(key)}="${oauthPercentEncode(value)}"`)
      .join(", ")
  );
}

export function createHmacSha1(key: string, value: string): string {
  return createHmac("sha1", key).update(value).digest("base64");
}

export function oauthPercentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

import { NativeModules, Platform } from "react-native";
import { loadShellCredential } from "./connect.js";

export const RN_HOST_ABI = "rn-host-2";

export interface NativeBundleHost {
  appendBundleChunk(
    base64: string,
    buildKey: string,
    artifactPath: string,
    first: boolean
  ): Promise<void>;
  finalizeBundleWrite(
    integrity: string,
    gzip: boolean
  ): Promise<{ localPath: string; buildKey?: string; integrity?: string }>;
  activatePreparedAppBundle(
    localPath: string,
    buildKey: string,
    integrity: string
  ): Promise<{ activated: boolean }>;
}

export interface BundleDeliveryTransport {
  rpc?: BundleDeliveryRpc;
  streamReadable?: BundleDeliveryRpc["streamReadable"];
}

export interface BundleDeliveryRpc {
  streamReadable(
    targetId: string,
    method: string,
    args: unknown[],
    options?: { body?: ReadableStream<Uint8Array> }
  ): Promise<{
    status: number;
    headers: Array<[string, string]>;
    body: ReadableStream<Uint8Array>;
  }>;
}

export class BundleGatewayFetchError extends Error {
  readonly status: number;

  constructor(path: string, status: number, detail: string) {
    super(`gateway.fetch ${path} failed (${status}): ${detail}`);
    this.name = "BundleGatewayFetchError";
    this.status = status;
  }
}

export interface ActivateWorkspaceAppOptions {
  source?: string | null;
  nativeHost?: NativeBundleHost;
  onCapabilities?: (capabilities: string[]) => void;
  smokePhase?: (phase: string) => void;
}

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_CODES = (() => {
  const codes = new Uint8Array(64);
  for (let i = 0; i < 64; i += 1) codes[i] = B64_ALPHABET.charCodeAt(i);
  return codes;
})();

function platformName(): "ios" | "android" {
  return Platform.OS === "ios" ? "ios" : "android";
}

function defaultNativeHost(): NativeBundleHost {
  const host = NativeModules["VibestudioMobileHost"] as NativeBundleHost | undefined;
  if (!host) throw new Error("VibestudioMobileHost native module is unavailable");
  return host;
}

function rpcFor(transport: BundleDeliveryTransport): BundleDeliveryRpc {
  if (transport.rpc?.streamReadable) return transport.rpc;
  if (transport.streamReadable) {
    return { streamReadable: transport.streamReadable.bind(transport) };
  }
  throw new Error("Bundle delivery transport does not support streamReadable");
}

function uint8ToBase64(bytes: Uint8Array): string {
  const len = bytes.length;
  const out = new Uint8Array(Math.ceil(len / 3) * 4);
  let o = 0;
  const fullEnd = len - (len % 3);
  for (let i = 0; i < fullEnd; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out[o++] = B64_CODES[(n >> 18) & 63]!;
    out[o++] = B64_CODES[(n >> 12) & 63]!;
    out[o++] = B64_CODES[(n >> 6) & 63]!;
    out[o++] = B64_CODES[n & 63]!;
  }
  const rem = len - fullEnd;
  if (rem === 1) {
    const n = bytes[fullEnd]! << 16;
    out[o++] = B64_CODES[(n >> 18) & 63]!;
    out[o++] = B64_CODES[(n >> 12) & 63]!;
    out[o++] = 61;
    out[o++] = 61;
  } else if (rem === 2) {
    const n = (bytes[fullEnd]! << 16) | (bytes[fullEnd + 1]! << 8);
    out[o++] = B64_CODES[(n >> 18) & 63]!;
    out[o++] = B64_CODES[(n >> 12) & 63]!;
    out[o++] = B64_CODES[(n >> 6) & 63]!;
    out[o++] = 61;
  }
  const parts: string[] = [];
  for (let p = 0; p < out.length; p += 0x8000) {
    parts.push(String.fromCharCode.apply(null, Array.from(out.subarray(p, p + 0x8000))));
  }
  return parts.join("");
}

async function drainStream(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value?.length) {
      chunks.push(value);
      total += value.length;
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

async function gatewayFetchBytes(
  rpc: BundleDeliveryRpc,
  descriptor: Record<string, unknown>,
  bodyText?: string
): Promise<Uint8Array> {
  const body =
    bodyText == null
      ? undefined
      : new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(bodyText));
            controller.close();
          },
        });
  const decoded = await rpc.streamReadable(
    "main",
    "gateway.fetch",
    [descriptor],
    body ? { body } : undefined
  );
  const bytes = await drainStream(decoded.body);
  if (decoded.status !== 200) {
    throw new BundleGatewayFetchError(
      String(descriptor["path"]),
      decoded.status,
      new TextDecoder().decode(bytes).slice(0, 300)
    );
  }
  return bytes;
}

function selectPrimaryArtifact(bootstrap: Record<string, unknown>, platform: "ios" | "android") {
  const artifacts = Array.isArray(bootstrap["artifacts"]) ? bootstrap["artifacts"] : [];
  const artifact = artifacts.find(
    (a) =>
      a &&
      typeof a === "object" &&
      (a as Record<string, unknown>)["role"] === "primary" &&
      (a as Record<string, unknown>)["platform"] === platform
  ) as Record<string, unknown> | undefined;
  if (!artifact) throw new Error(`No primary React Native bundle artifact for ${platform}`);
  return artifact;
}

async function streamArtifactToNative(
  rpc: BundleDeliveryRpc,
  nativeHost: NativeBundleHost,
  descriptor: Record<string, unknown>,
  buildKey: string,
  artifactPath: string
): Promise<boolean> {
  const decoded = await rpc.streamReadable("main", "gateway.fetch", [descriptor]);
  if (decoded.status !== 200) {
    const bytes = await drainStream(decoded.body);
    throw new Error(
      `bundle artifact fetch failed (${decoded.status}): ` +
        new TextDecoder().decode(bytes).slice(0, 300)
    );
  }
  const gzipped = decoded.headers.some(
    (h) => h[0].toLowerCase() === "x-vibestudio-content-gzip" && h[1] === "1"
  );
  const reader = decoded.body.getReader();
  let first = true;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value?.length) {
      await nativeHost.appendBundleChunk(uint8ToBase64(value), buildKey, artifactPath, first);
      first = false;
    }
  }
  if (first) throw new Error("bundle artifact stream was empty");
  return gzipped;
}

export async function activateApprovedWorkspaceApp(
  transport: BundleDeliveryTransport,
  options: ActivateWorkspaceAppOptions = {}
): Promise<Record<string, unknown>> {
  const nativeHost = options.nativeHost ?? defaultNativeHost();
  const stored = await loadShellCredential();
  if (!stored) {
    throw new Error(
      "Pair this device with a trusted Vibestudio server before loading the workspace app."
    );
  }
  const rpc = rpcFor(transport);
  const bootstrapBody: Record<string, unknown> = {
    deviceId: stored.deviceId,
    refreshToken: stored.refreshToken,
  };
  if (typeof options.source === "string" && options.source.length > 0) {
    bootstrapBody["source"] = options.source;
  }
  const manifestBytes = await gatewayFetchBytes(
    rpc,
    {
      path: "/_r/s/auth/mobile-app-bootstrap",
      method: "POST",
      headers: { "content-type": "application/json" },
    },
    JSON.stringify(bootstrapBody)
  );
  const bootstrap = JSON.parse(new TextDecoder().decode(manifestBytes))?.bootstrap as
    | Record<string, unknown>
    | undefined;
  if (!bootstrap) throw new Error("Mobile app bootstrap returned no manifest");
  if (bootstrap["rnHostAbi"] !== RN_HOST_ABI) {
    throw new Error(
      `React Native host ABI mismatch: expected ${RN_HOST_ABI}, got ${String(bootstrap["rnHostAbi"])}. Reinstall the Vibestudio mobile shell.`
    );
  }
  const capabilities = Array.isArray(bootstrap["capabilities"])
    ? bootstrap["capabilities"].filter((capability): capability is string => typeof capability === "string")
    : [];
  options.onCapabilities?.(capabilities);
  options.smokePhase?.("embedded-bundle-activate-start");
  const buildKey = String(bootstrap["buildKey"] ?? "");
  if (!buildKey) throw new Error("Mobile app bootstrap did not include a build key");
  const artifact = selectPrimaryArtifact(bootstrap, platformName());
  const integrity = String(artifact["integrity"] ?? "");
  const artifactUrl = String(artifact["url"] ?? "");
  if (!integrity || !artifactUrl) throw new Error("Mobile app artifact is missing integrity or URL");
  const artifactPath = new URL(artifactUrl).pathname;
  const nativeArtifactPath = String(artifact["path"] ?? artifactPath);
  const gzipped = await streamArtifactToNative(
    rpc,
    nativeHost,
    { path: artifactPath, method: "GET", gzip: true },
    buildKey,
    nativeArtifactPath
  );
  const prepared = await nativeHost.finalizeBundleWrite(integrity, gzipped);
  await nativeHost.activatePreparedAppBundle(prepared.localPath, buildKey, integrity);
  options.smokePhase?.("embedded-bundle-activate-complete");
  return bootstrap;
}

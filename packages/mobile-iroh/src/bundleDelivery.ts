import { NativeModules, Platform } from "react-native";
import { RESUMABLE_GZIP_HEADER } from "@vibestudio/shared/panel/assetHeaders";
import { loadShellCredential } from "./connect.js";
import { retryBundleTransfer } from "./bundleTransferRetry.js";

export const RN_HOST_ABI = "rn-host-4";

export interface BrowserImportArchiveEntry {
  name: string;
  size: number;
}

export interface BrowserImportArchiveHandle {
  handle: string;
  displayName: string;
  mimeType?: string;
  size: number;
  entries: BrowserImportArchiveEntry[];
}

export interface NativeBundleHost {
  openSafariBrowserDataExport(): Promise<{
    opened: boolean;
    unavailableReason?: string;
  }>;
  pickBrowserImportArchive(): Promise<BrowserImportArchiveHandle | null>;
  readBrowserImportEntry(
    handle: string,
    name: string,
    offset: number,
    maxBytes: number
  ): Promise<{ dataBase64: string; eof: boolean }>;
  releaseBrowserImportArchive(handle: string): Promise<void>;
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
  reloadActiveAppBundle(): Promise<{ reloading: boolean }>;
}

export interface BundleDeliveryTransport {
  rpc?: BundleDeliveryRpc;
  streamReadable?: BundleDeliveryRpc["streamReadable"];
  /** Await the existing authenticated transport when a transfer trips over recovery. */
  waitUntilConnected?: (timeoutMs: number) => Promise<void>;
  /**
   * Bundle delivery consumes the bootstrap transport. It must be fully closed
   * before native starts the workspace runtime, otherwise both runtimes retain
   * offerer ownership and continuously supersede one another.
   */
  close(): Promise<void>;
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

const MOBILE_BOOTSTRAP_WAIT_MS = 180_000;
const MOBILE_BOOTSTRAP_RETRY_MS = 1_000;
const MOBILE_BUNDLE_TRANSFER_RETRY_MS = 1_500;
const MOBILE_BUNDLE_RECONNECT_WAIT_MS = 30_000;
const MOBILE_BUNDLE_TRANSFER_TIMEOUT_MS = 5 * 60_000;
// A bounded response window is application-level backpressure across React
// Native's native-to-JS event bridge. QUIC can report its own queue drained
// before JS has consumed the corresponding events; limiting each RPC response
// prevents one long artifact stream from flooding that final hop.
// Keep the application window below the one-MiB native/JS delivery boundary,
// rather than landing exactly on it. A physical RN data channel repeatedly
// delivered an exact one-MiB range 20 bytes short (one mux header per 256-KiB
// transport segment); the integrity guard recovered, but retries must be an
// exceptional recovery path. 512 KiB keeps peak base64 allocation modest
// (~683 KiB) and costs only one additional range round trip for today's bundle.
const BUNDLE_RANGE_WINDOW_BYTES = 512 * 1024;
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

function retryableMobileBootstrapError(error: unknown): boolean {
  return (
    error instanceof BundleGatewayFetchError &&
    error.status === 503 &&
    error.message.includes('"code":"MOBILE_APP_UNAVAILABLE"')
  );
}

async function waitForMobileBootstrap(
  rpc: BundleDeliveryRpc,
  bootstrapBody: Record<string, unknown>,
  options: ActivateWorkspaceAppOptions
): Promise<Uint8Array> {
  const deadline = Date.now() + MOBILE_BOOTSTRAP_WAIT_MS;
  for (;;) {
    try {
      return await gatewayFetchBytes(
        rpc,
        {
          path: "/_r/s/auth/mobile-app-bootstrap",
          method: "POST",
          headers: { "content-type": "application/json" },
        },
        JSON.stringify(bootstrapBody)
      );
    } catch (error) {
      if (!retryableMobileBootstrapError(error) || Date.now() >= deadline) throw error;
      options.smokePhase?.("embedded-host-target-preparing");
      await new Promise((resolve) => setTimeout(resolve, MOBILE_BOOTSTRAP_RETRY_MS));
    }
  }
}

async function streamArtifactToNative(
  rpc: BundleDeliveryRpc,
  nativeHost: NativeBundleHost,
  descriptor: Record<string, unknown>,
  buildKey: string,
  artifactPath: string,
  transfer: { offset: number }
): Promise<boolean> {
  const expectedOffset = transfer.offset;
  let totalLength: number | null = null;
  for (;;) {
    const windowStartedAt = Date.now();
    const rangeEnd = transfer.offset + BUNDLE_RANGE_WINDOW_BYTES - 1;
    const headers = {
      ...((descriptor["headers"] as Record<string, string> | undefined) ?? {}),
      [RESUMABLE_GZIP_HEADER]: "1",
      Range: `bytes=${transfer.offset}-${rangeEnd}`,
    };
    const decoded = await rpc.streamReadable("main", "gateway.fetch", [
      { ...descriptor, gzip: true, headers },
    ]);
    if (decoded.status !== 206) {
      const bytes = await drainStream(decoded.body);
      throw new Error(
        `bundle artifact fetch failed (${decoded.status}): ` +
          new TextDecoder().decode(bytes).slice(0, 300)
      );
    }
    const gzipped = decoded.headers.some(
      (h) => h[0].toLowerCase() === "x-vibestudio-content-gzip" && h[1] === "1"
    );
    if (!gzipped) throw new Error("bundle artifact server did not honor resumable gzip transfer");
    const contentRange = decoded.headers.find((h) => h[0].toLowerCase() === "content-range")?.[1];
    const match = contentRange ? /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(contentRange) : null;
    const rangeStart = Number(match?.[1]);
    const declaredEnd = Number(match?.[2]);
    const declaredTotal = Number(match?.[3]);
    if (
      rangeStart !== transfer.offset ||
      !Number.isSafeInteger(declaredEnd) ||
      !Number.isSafeInteger(declaredTotal) ||
      declaredEnd < rangeStart ||
      declaredEnd >= declaredTotal ||
      (totalLength !== null && declaredTotal !== totalLength)
    ) {
      throw new Error("bundle artifact response declared an invalid byte range");
    }
    const window = await drainStream(decoded.body);
    const declaredLength = declaredEnd - rangeStart + 1;
    if (window.length !== declaredLength) {
      const error = new Error(
        `bundle artifact range was incomplete: expected ${declaredLength} bytes, received ${window.length}`
      ) as Error & { code: string };
      error.code = "BUNDLE_RANGE_INCOMPLETE";
      throw error;
    }
    totalLength = declaredTotal;
    await nativeHost.appendBundleChunk(
      uint8ToBase64(window),
      buildKey,
      artifactPath,
      transfer.offset === 0
    );
    transfer.offset += window.length;
    console.info(
      `[mobile-bundle] received ${window.length} bytes at offset ${rangeStart} in ` +
        `${Date.now() - windowStartedAt}ms (${transfer.offset}/${totalLength})`
    );
    if (transfer.offset === totalLength) break;
  }
  if (transfer.offset === expectedOffset) throw new Error("bundle artifact stream was empty");
  return true;
}

function transferCanResume(error: unknown): boolean {
  const code =
    error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string"
      ? (error as { code: string }).code
      : "";
  if (code === "CONNECTION_LOST" || code === "BUNDLE_RANGE_INCOMPLETE") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /connection lost|not connected to server|pipe down|ice failed/iu.test(message);
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
  if (stored.schemaVersion !== 5 || stored.phase !== "routed") {
    throw new Error("The mobile workspace route was not committed before app activation.");
  }
  const rpc = rpcFor(transport);
  const bootstrapBody: Record<string, unknown> = {
    deviceId: stored.credential.deviceId,
    refreshToken: stored.credential.refreshToken,
  };
  if (typeof options.source === "string" && options.source.length > 0) {
    bootstrapBody["source"] = options.source;
  }
  const manifestBytes = await waitForMobileBootstrap(rpc, bootstrapBody, options);
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
    ? bootstrap["capabilities"].filter(
        (capability): capability is string => typeof capability === "string"
      )
    : [];
  options.onCapabilities?.(capabilities);
  options.smokePhase?.("embedded-bundle-activate-start");
  const buildKey = String(bootstrap["buildKey"] ?? "");
  if (!buildKey) throw new Error("Mobile app bootstrap did not include a build key");
  const artifact = selectPrimaryArtifact(bootstrap, platformName());
  const integrity = String(artifact["integrity"] ?? "");
  const artifactUrl = String(artifact["url"] ?? "");
  if (!integrity || !artifactUrl)
    throw new Error("Mobile app artifact is missing integrity or URL");
  const artifactPath = new URL(artifactUrl).pathname;
  const nativeArtifactPath = String(artifact["path"] ?? artifactPath);
  const transfer = { offset: 0 };
  const prepared = await retryBundleTransfer(
    async () => {
      const gzipped = await streamArtifactToNative(
        rpc,
        nativeHost,
        { path: artifactPath, method: "GET" },
        buildKey,
        nativeArtifactPath,
        transfer
      );
      return await nativeHost.finalizeBundleWrite(integrity, gzipped);
    },
    {
      timeoutMs: MOBILE_BUNDLE_TRANSFER_TIMEOUT_MS,
      onRetry: (error) => {
        if (!transferCanResume(error)) transfer.offset = 0;
        options.smokePhase?.("embedded-bundle-transfer-retry");
        console.warn(
          `[mobile-bundle] retrying offset=${transfer.offset}: ${error instanceof Error ? error.message : String(error)}`
        );
      },
      wait: () =>
        transport.waitUntilConnected?.(MOBILE_BUNDLE_RECONNECT_WAIT_MS) ??
        new Promise((resolve) => setTimeout(resolve, MOBILE_BUNDLE_TRANSFER_RETRY_MS)),
    }
  );
  await nativeHost.activatePreparedAppBundle(prepared.localPath, buildKey, integrity);
  await transport.close();
  await nativeHost.reloadActiveAppBundle();
  options.smokePhase?.("embedded-bundle-activate-complete");
  return bootstrap;
}

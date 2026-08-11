import { NativeModules } from "react-native";
import { Buffer } from "buffer";

export const MOBILE_ASSET_STORE_MAX_BYTES = 256 * 1024 * 1024;

export interface MobileAssetStoreNamespace {
  /** Pinned control-pairing DTLS fingerprint. */
  serverIdentity: string;
  /** Authoritative workspace id returned by workspaces.getInfo. */
  workspaceIdentity: string;
}

export interface MobileStoredAssetMetadata {
  status: 200;
  statusText: string;
  gzip: boolean;
  contentType: string;
  replayHeaders: Record<string, string>;
}

export interface MobileStoredAsset {
  handle: string;
  size: number;
  metadata: MobileStoredAssetMetadata;
}

export interface NativeMobileAssetStoreHost {
  assetStoreLookup(
    namespace: MobileAssetStoreNamespace,
    key: string
  ): Promise<{ handle: string; size: number; metadataJson: string } | null>;
  assetStoreOpenWrite(namespace: MobileAssetStoreNamespace, key: string): Promise<string>;
  assetStoreAppend(writeId: string, bytesBase64: string): Promise<void>;
  assetStoreCommit(
    writeId: string,
    metadataJson: string
  ): Promise<{ handle: string; size: number; metadataJson: string }>;
  assetStoreAbort(writeId: string): Promise<void>;
  assetStoreTrim(maxBytes: number): Promise<void>;
  assetStoreClear(): Promise<void>;
}

type PopulationResult =
  | { kind: "complete"; asset: MobileStoredAsset | null }
  | { kind: "failed"; error: unknown };

export type MobileAssetAcquisition =
  | { kind: "hit"; asset: MobileStoredAsset }
  | {
      kind: "owner";
      complete(asset: MobileStoredAsset | null): void;
      fail(error: unknown): void;
    };

const STORED_HANDLE = /^vibestudio-asset-v1:[a-f0-9]{64}$/u;
const SERVER_IDENTITY = /^[a-f0-9]{64}$/u;

/**
 * Native durable store adapter plus JS-owned single-flight coordination.
 * Namespace is captured by the instance and passed on every keyed native
 * operation; a workspace switch cannot redirect a late write into a new index.
 */
export class MobileAssetStore {
  private readonly inflight = new Map<string, Promise<PopulationResult>>();
  private readonly operations = new Set<Promise<unknown>>();
  private closing = false;

  constructor(
    readonly namespace: MobileAssetStoreNamespace,
    private readonly nativeHost: NativeMobileAssetStoreHost = requireNativeAssetStoreHost()
  ) {
    validateNamespace(namespace);
  }

  async acquire(key: string): Promise<MobileAssetAcquisition> {
    this.assertOpen();
    validateKey(key);
    for (;;) {
      const existing = this.inflight.get(key);
      if (existing) {
        const result = await existing;
        if (result.kind === "failed") throw result.error;
        if (result.asset) return { kind: "hit", asset: result.asset };
        continue;
      }

      let settle!: (result: PopulationResult) => void;
      const population = new Promise<PopulationResult>((resolve) => {
        settle = resolve;
      });
      // Claim the key before the first asynchronous lookup. Otherwise two
      // callers can both observe a stale native miss; if the first population
      // finishes before the second lookup resumes, the second caller sees no
      // flight and unnecessarily downloads the artifact again.
      this.inflight.set(key, population);
      let settled = false;
      const finish = (result: PopulationResult): void => {
        if (settled) return;
        settled = true;
        this.inflight.delete(key);
        settle(result);
      };
      try {
        const hit = parseStoredAsset(
          await this.track(this.nativeHost.assetStoreLookup(this.namespace, key))
        );
        if (hit) {
          finish({ kind: "complete", asset: hit });
          return { kind: "hit", asset: hit };
        }
      } catch (error) {
        finish({ kind: "failed", error });
        throw error;
      }
      return {
        kind: "owner",
        complete: (asset) => finish({ kind: "complete", asset }),
        fail: (error) => finish({ kind: "failed", error }),
      };
    }
  }

  openWrite(key: string): Promise<string> {
    this.assertOpen();
    validateKey(key);
    return this.track(this.nativeHost.assetStoreOpenWrite(this.namespace, key));
  }

  append(writeId: string, bytes: Uint8Array): Promise<void> {
    if (!writeId) throw new Error("Asset-store write handle is required");
    return this.track(this.nativeHost.assetStoreAppend(writeId, uint8ToBase64(bytes)));
  }

  async commit(writeId: string, metadata: MobileStoredAssetMetadata): Promise<MobileStoredAsset> {
    validateMetadata(metadata);
    return parseRequiredStoredAsset(
      await this.track(this.nativeHost.assetStoreCommit(writeId, JSON.stringify(metadata)))
    );
  }

  abort(writeId: string): Promise<void> {
    return this.track(this.nativeHost.assetStoreAbort(writeId));
  }

  trim(maxBytes = MOBILE_ASSET_STORE_MAX_BYTES): Promise<void> {
    this.assertOpen();
    return this.track(this.nativeHost.assetStoreTrim(maxBytes));
  }

  clear(): Promise<void> {
    this.assertOpen();
    return this.track(this.nativeHost.assetStoreClear());
  }

  /** Stop new acquisitions and wait until every owned population/native call settles. */
  async close(): Promise<void> {
    this.closing = true;
    let firstError: unknown = null;
    for (;;) {
      const pending = [...this.inflight.values(), ...this.operations];
      if (pending.length === 0) {
        if (firstError !== null) throw firstError;
        return;
      }
      for (const result of await Promise.allSettled(pending)) {
        if (result.status === "rejected" && firstError === null) firstError = result.reason;
      }
    }
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.operations.add(operation);
    void operation.then(
      () => this.operations.delete(operation),
      () => this.operations.delete(operation)
    );
    return operation;
  }

  private assertOpen(): void {
    if (this.closing) throw new Error("Mobile asset store is closing");
  }
}

function requireNativeAssetStoreHost(): NativeMobileAssetStoreHost {
  const host = NativeModules["VibestudioMobileHost"] as NativeMobileAssetStoreHost | undefined;
  const required: Array<keyof NativeMobileAssetStoreHost> = [
    "assetStoreLookup",
    "assetStoreOpenWrite",
    "assetStoreAppend",
    "assetStoreCommit",
    "assetStoreAbort",
    "assetStoreTrim",
    "assetStoreClear",
  ];
  if (!host || required.some((method) => typeof host[method] !== "function")) {
    throw new Error("VibestudioMobileHost durable asset store is unavailable");
  }
  return host;
}

function validateNamespace(namespace: MobileAssetStoreNamespace): void {
  if (!SERVER_IDENTITY.test(namespace.serverIdentity.toLowerCase())) {
    throw new Error("Mobile asset namespace has an invalid server identity");
  }
  if (
    !namespace.workspaceIdentity ||
    namespace.workspaceIdentity.length > 512 ||
    namespace.workspaceIdentity.includes("\0")
  ) {
    throw new Error("Mobile asset namespace has an invalid workspace identity");
  }
}

function validateKey(key: string): void {
  if (!key || key.length > 16 * 1024 || key.includes("\0")) {
    throw new Error("Invalid mobile asset-store key");
  }
}

function validateMetadata(metadata: MobileStoredAssetMetadata): void {
  const cacheControl = Object.entries(metadata.replayHeaders).find(
    ([key]) => key.toLowerCase() === "cache-control"
  )?.[1];
  const cacheDirectives = cacheControl?.split(",").map((token) => token.trim().toLowerCase());
  if (
    metadata.status !== 200 ||
    !metadata.contentType ||
    typeof metadata.gzip !== "boolean" ||
    !cacheDirectives?.includes("immutable") ||
    cacheDirectives.includes("no-store")
  ) {
    throw new Error("Only successful immutable responses can enter the mobile asset store");
  }
}

function parseStoredAsset(
  raw: { handle: string; size: number; metadataJson: string } | null
): MobileStoredAsset | null {
  return raw === null ? null : parseRequiredStoredAsset(raw);
}

function parseRequiredStoredAsset(raw: {
  handle: string;
  size: number;
  metadataJson: string;
}): MobileStoredAsset {
  if (
    !STORED_HANDLE.test(raw.handle) ||
    !Number.isSafeInteger(raw.size) ||
    raw.size < 0 ||
    typeof raw.metadataJson !== "string"
  ) {
    throw new Error("Native mobile asset store returned an invalid handle");
  }
  let metadata: MobileStoredAssetMetadata;
  try {
    metadata = JSON.parse(raw.metadataJson) as MobileStoredAssetMetadata;
  } catch {
    throw new Error("Native mobile asset store returned invalid metadata");
  }
  validateMetadata(metadata);
  return { handle: raw.handle, size: raw.size, metadata };
}

function uint8ToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

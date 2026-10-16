import { gatewayMethods } from "@vibestudio/service-schemas/gateway";
import { mainRpcMethods } from "@vibestudio/service-schemas/mainRpc";
import type {
  ClientArtifactFetch,
  ClientArtifactStore,
} from "@vibestudio/client-host-core/artifactCache";
import { base64ToBytes, bytesToBase64, type RpcClient } from "@vibestudio/rpc";

/**
 * Mobile delivery of verified client artifacts.
 *
 * The launch pipeline (`ClientLauncher` + `ClientArtifactCache` of
 * `@vibestudio/client-host-core`) decides what to fetch, verifies every byte
 * against the integrity the server sealed, and only then asks a store to keep
 * it. This module is the mobile half of those two ports:
 *
 * - {@link createMobileArtifactStore}: the `ClientArtifactStore` over the
 *   native artifact store of the host runtime. Native hashes the bytes again
 *   before it publishes them and again before it loads a bundle, so the
 *   verification does not depend on this JavaScript staying honest.
 * - {@link createGatewayArtifactFetch}: the `ClientArtifactFetch` over the
 *   device's workspace session (`gateway.fetch`).
 *
 * There is no resumable transfer, retry loop or activation here: a failed
 * transfer fails the launch, and the next launch fetches again.
 */

/** The artifact-store half of the host runtime's native module. */
export interface NativeArtifactStore {
  artifactHas(integrity: string): Promise<boolean>;
  /** Start a write; bytes accumulate in staging, invisible to readers. */
  artifactBeginWrite(integrity: string, name: string): Promise<string>;
  artifactAppend(writeId: string, bytesBase64: string): Promise<void>;
  /**
   * Hash the staged bytes; publish atomically when they match the declared
   * integrity, otherwise discard them and reject with `integrity-mismatch`.
   */
  artifactCommit(writeId: string): Promise<void>;
  artifactAbort(writeId: string): Promise<void>;
  artifactList(): Promise<string[]>;
  artifactRemove(integrity: string): Promise<void>;
  /** Absolute path of a stored artifact (rejects when absent). */
  artifactLocate(integrity: string): Promise<string>;
  /** The whole stored artifact, base64 (small artifacts only). */
  artifactRead(integrity: string): Promise<string>;
}

/** Bytes per native append; the bridge carries base64, so keep bridge messages modest. */
export const ARTIFACT_WRITE_CHUNK_BYTES = 256 * 1024;

export function createMobileArtifactStore(native: NativeArtifactStore): ClientArtifactStore {
  return {
    has: (integrity) => native.artifactHas(integrity),
    async read(integrity) {
      return base64ToBytes(await native.artifactRead(integrity));
    },
    async writeVerified(integrity, bytes, name) {
      const writeId = await native.artifactBeginWrite(integrity, name);
      try {
        for (let offset = 0; offset < bytes.length; offset += ARTIFACT_WRITE_CHUNK_BYTES) {
          await native.artifactAppend(
            writeId,
            bytesToBase64(bytes.subarray(offset, offset + ARTIFACT_WRITE_CHUNK_BYTES))
          );
        }
        await native.artifactCommit(writeId);
      } catch (failure) {
        // The write failed; staging must not outlive it. Keep the original
        // failure and add the cleanup's when that fails too.
        try {
          await native.artifactAbort(writeId);
        } catch (cleanup) {
          throw new AggregateError(
            [failure, cleanup],
            "Artifact write failed and its staging could not be discarded",
            { cause: failure }
          );
        }
        throw failure;
      }
    },
    list: () => native.artifactList(),
    remove: (integrity) => native.artifactRemove(integrity),
    locate: (integrity) => native.artifactLocate(integrity),
  };
}

/**
 * `gateway.fetch` over a device session. React Native cannot build a browser
 * `Response` around a stream, so the decoded stream is read by the cache
 * directly; the object returned carries the three members the cache reads.
 */
export function createGatewayArtifactFetch(
  rpc: Pick<RpcClient, "streamReadable">
): ClientArtifactFetch {
  return async (route) => {
    const decoded = await rpc.streamReadable(
      "main",
      mainRpcMethods["gateway.fetch"],
      gatewayMethods.fetch.args.parse([{ path: route, method: "GET" }])
    );
    return {
      ok: decoded.status >= 200 && decoded.status < 300,
      status: decoded.status,
      body: decoded.body,
    };
  };
}

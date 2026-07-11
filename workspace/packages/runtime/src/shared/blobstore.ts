/**
 * Blobstore client — the portable runtime binding for the per-workspace
 * content-addressable blob store, shared by panel · worker · eval.
 *
 * This is the curated client behind `services.blobstore` / `import { blobstore }
 * from "@workspace/runtime"`. It is a thin typed wrapper over the `blobstore`
 * RPC service (`@vibestudio/shared/serviceSchemas/blobstore`). Service methods
 * forward to `rpc.call("main", "blobstore.<method>", args)`; runtime-only
 * `putBytes` losslessly encodes bytes before delegating to `putBase64`.
 *
 * Read/write methods (`putText`/`putBase64`/`putBytes`/`getText`/`getRange`/`grep`/…) admit
 * `panel`/`worker`/`do` callers (BLOBSTORE_READ_POLICY), so persisting a
 * screenshot or large artifact from agent eval works. Admin methods
 * (`delete`/`list`) are shell/server-only and reject other caller kinds at the
 * service policy gate — same as any other namespaced service method.
 */

import { Buffer } from "buffer";
import type { RpcCaller } from "@vibestudio/rpc";
import {
  createTypedServiceClient,
  type TypedServiceClient,
} from "@vibestudio/shared/typedServiceClient";
import { blobstoreMethods } from "@vibestudio/shared/serviceSchemas/blobstore";

type BlobstoreServiceClient = TypedServiceClient<typeof blobstoreMethods>;
type PutBlobResult = Awaited<ReturnType<BlobstoreServiceClient["putBase64"]>>;

export type BlobstoreBytes = Uint8Array | ArrayBuffer;

export type BlobstoreClient = BlobstoreServiceClient & {
  /** Runtime-only byte convenience; the wire service remains base64-only. */
  putBytes(bytes: BlobstoreBytes): Promise<PutBlobResult>;
};

/** Live runtime members; parity tests keep this aligned with the shared surface manifest. */
export const BLOBSTORE_MEMBERS = [...Object.keys(blobstoreMethods), "putBytes"];

export function createBlobstoreClient(rpc: RpcCaller): BlobstoreClient {
  const serviceClient = createTypedServiceClient(
    "blobstore",
    blobstoreMethods,
    (svc, method, args) => rpc.call("main", `${svc}.${method}`, args)
  );

  const putBytes = async (...args: unknown[]): Promise<PutBlobResult> => {
    if (args.length !== 1) {
      throw new TypeError(
        `blobstore.putBytes accepts exactly one Uint8Array or ArrayBuffer argument; ` +
          `MIME metadata is not stored, so return it alongside the digest instead (received ${args.length} arguments).`
      );
    }

    const input = args[0];
    if (!(input instanceof Uint8Array) && !(input instanceof ArrayBuffer)) {
      throw new TypeError("blobstore.putBytes expects a Uint8Array or ArrayBuffer argument.");
    }

    const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
    return serviceClient.putBase64(Buffer.from(bytes).toString("base64"));
  };

  return Object.assign(serviceClient, { putBytes });
}

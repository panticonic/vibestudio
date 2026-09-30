import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";
import { join, dirname } from "node:path";
import {
  EncryptedJsonStore,
  getDefaultCredentialStorePath,
} from "@vibestudio/credential-client/encryptedJsonStore";
import {
  reportSignaturePayload,
  type ReportSignature,
} from "@vibestudio/service-schemas/problemReportBundle";

type SigningKey = { algorithm: "Ed25519"; privateKey: string };
/** Uses the host's encrypted external secret store. Never mounted in a workspace or exposed by a service. */
class MachineKeyStore extends EncryptedJsonStore<SigningKey> {
  constructor(basePath?: string) {
    super({
      basePath,
      defaultBasePath: join(dirname(getDefaultCredentialStorePath()), "report-signing"),
      processPortable: true,
    });
  }
  async key(): Promise<KeyObject> {
    let record = await this.loadRecord("machine", "ed25519");
    if (!record) {
      const pair = generateKeyPairSync("ed25519");
      const candidate: SigningKey = {
        algorithm: "Ed25519",
        privateKey: pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      };
      await this.createRecord("machine", "ed25519", candidate);
      record = await this.loadRecord("machine", "ed25519");
    }
    if (!record || record.algorithm !== "Ed25519")
      throw new Error("Machine report signing key unavailable");
    const key = createPrivateKey(record.privateKey);
    if (key.asymmetricKeyType !== "ed25519") throw new Error("Invalid machine report signing key");
    return key;
  }
}
export type ReportSigner = (
  submissionId: string,
  digest: string,
  receiptSecretDigest: string
) => Promise<ReportSignature>;
export function createMachineReportSigner(basePath?: string): ReportSigner {
  const store = new MachineKeyStore(basePath);
  let pending: Promise<KeyObject> | null = null;
  return async (id, digest, receiptDigest) => {
    const key = await (pending ??= store.key().catch((error) => {
      pending = null;
      throw error;
    }));
    const jwk = createPublicKey(key).export({ format: "jwk" });
    return {
      publicKey: Buffer.from(jwk.x!, "base64url").toString("hex"),
      signature: sign(null, reportSignaturePayload(id, digest, receiptDigest), key).toString("hex"),
    };
  };
}

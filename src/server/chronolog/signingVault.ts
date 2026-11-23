import { createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { dirname, join } from "node:path";
import {
  EncryptedJsonStore,
  getDefaultCredentialStorePath,
} from "@vibestudio/credential-client/encryptedJsonStore";

interface SigningKeyRecord {
  version: 1;
  pkcs8Hex: string;
}

/** One principal per authenticated account, owned by the hub credential store. */
export class ChronologSigningVault extends EncryptedJsonStore<SigningKeyRecord> {
  constructor(basePath?: string) {
    super({
      basePath,
      defaultBasePath: join(dirname(getDefaultCredentialStorePath()), "chronolog-signing"),
      processPortable: true,
    });
  }

  async principal(userId: string): Promise<{ publicKey: string; pkcs8Hex: string }> {
    let record = await this.loadRecord(userId, "ed25519");
    if (!record) {
      const { privateKey } = generateKeyPairSync("ed25519");
      const bytes = privateKey.export({ format: "der", type: "pkcs8" });
      try {
        await this.createRecord(userId, "ed25519", { version: 1, pkcs8Hex: bytes.toString("hex") });
      } finally {
        bytes.fill(0);
      }
      record = await this.loadRecord(userId, "ed25519");
    }
    if (record?.version !== 1 || !/^(?:[a-f0-9]{2}){1,256}$/u.test(record.pkcs8Hex)) {
      throw new Error("The Chronolog account principal is unavailable");
    }
    const bytes = Buffer.from(record.pkcs8Hex, "hex");
    try {
      const privateKey = createPrivateKey({ key: bytes, format: "der", type: "pkcs8" });
      if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("Invalid Chronolog account key");
      const publicKey = createPublicKey(privateKey).export({ format: "jwk" });
      if (!publicKey.x) throw new Error("The Chronolog account principal has no public key");
      const raw = Buffer.from(publicKey.x, "base64url");
      if (raw.length !== 32) throw new Error("Invalid Chronolog account public key");
      return { publicKey: raw.toString("hex"), pkcs8Hex: record.pkcs8Hex };
    } finally {
      bytes.fill(0);
    }
  }
}

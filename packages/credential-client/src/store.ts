import type { Credential } from "./types.js";
import {
  assertValidStoreIdentifier,
  EncryptedJsonStore,
  getDefaultCredentialStorePath,
  __setSafeStorageForTests,
} from "./encryptedJsonStore.js";

export { __setSafeStorageForTests };

const URL_BOUND_PROVIDER_NAMESPACE = "url-bound";

export class CredentialStore extends EncryptedJsonStore<Credential> {
  constructor(options: { basePath?: string } = {}) {
    super({ basePath: options.basePath, defaultBasePath: getDefaultCredentialStorePath() });
  }

  async save(credential: Credential): Promise<void> {
    assertValidStoreIdentifier("providerId", credential.providerId);
    assertValidStoreIdentifier("connectionId", credential.connectionId);
    await this.saveRecord(credential.providerId, credential.connectionId, credential);
  }

  async saveUrlBound(credential: Credential & { id: string }): Promise<void> {
    assertValidStoreIdentifier("credentialId", credential.id);
    await this.saveRecord(URL_BOUND_PROVIDER_NAMESPACE, credential.id, {
      ...credential,
      providerId: URL_BOUND_PROVIDER_NAMESPACE,
      connectionId: credential.id,
    });
  }

  async loadUrlBound(id: string): Promise<Credential | null> {
    assertValidStoreIdentifier("credentialId", id);
    return this.loadRecord(URL_BOUND_PROVIDER_NAMESPACE, id);
  }

  async listUrlBound(): Promise<Credential[]> {
    return this.listRecords(URL_BOUND_PROVIDER_NAMESPACE);
  }

  async removeUrlBound(id: string): Promise<void> {
    assertValidStoreIdentifier("credentialId", id);
    await this.removeRecord(URL_BOUND_PROVIDER_NAMESPACE, id);
  }

  async load(providerId: string, connectionId: string): Promise<Credential | null> {
    assertValidStoreIdentifier("providerId", providerId);
    assertValidStoreIdentifier("connectionId", connectionId);
    return this.loadRecord(providerId, connectionId);
  }

  async list(providerId?: string): Promise<Credential[]> {
    if (providerId !== undefined) {
      assertValidStoreIdentifier("providerId", providerId);
    }
    return this.listRecords(providerId);
  }

  async remove(providerId: string, connectionId: string): Promise<void> {
    assertValidStoreIdentifier("providerId", providerId);
    assertValidStoreIdentifier("connectionId", connectionId);
    await this.removeRecord(providerId, connectionId);
  }
}

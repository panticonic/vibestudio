/**
 * Frozen, language-neutral values for the legacy Vibe Blob/Tree codec.
 * These strings are intentionally duplicated from existing golden tests so
 * downstream adapters can verify byte and identity compatibility directly.
 */
export const VIBE_CONTENT_STORE_FIXTURES_V1 = {
  version: 1,
  reducerProtocolVersion: 0,
  hashAlgorithm: { name: "sha2-256", number: 0x12 },
  codecs: {
    blob: { number: 0x300001, version: 1 },
    tree: { number: 0x56425431, version: 1 },
    state: { number: 0x56425331, version: 1 },
  },
  emptyBlob: {
    bytesUtf8: "",
    sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  },
  emptyTree: {
    bytesUtf8: '{"entries":[],"kind":"dir"}',
    sha256: "48d1be9db5b498b22aa5db6ae3fa3b7f864bba5b4edf70dfc717cab0c5bea526",
    legacyRef: "manifest:48d1be9db5b498b22aa5db6ae3fa3b7f864bba5b4edf70dfc717cab0c5bea526",
  },
  emptyState: {
    bytesUtf8:
      '{"manifestRootHash":"manifest:48d1be9db5b498b22aa5db6ae3fa3b7f864bba5b4edf70dfc717cab0c5bea526"}',
    sha256: "ffa8c21b351f3a31755c289c37c413d37f4494057cb724cc32ad5971de89d8a7",
    legacyRef: "state:ffa8c21b351f3a31755c289c37c413d37f4494057cb724cc32ad5971de89d8a7",
  },
  fileTree: {
    bytesUtf8:
      '{"entries":[{"contentHash":"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855","kind":"file","mode":33188,"name":"empty.txt"}],"kind":"dir"}',
    sha256: "ff3ebcfb1d743cdf5adcb1e6fc884326f410a7e7d97b8150e3e9a79ea9dfcbe0",
  },
  directoryTree: {
    bytesUtf8:
      '{"entries":[{"childHash":"manifest:48d1be9db5b498b22aa5db6ae3fa3b7f864bba5b4edf70dfc717cab0c5bea526","kind":"dir","name":"empty"}],"kind":"dir"}',
    sha256: "16cc5848b777d6da5a6f8d9cf82226ee8ac5f8cf36c0394d2b0707998a273c7e",
  },
} as const;

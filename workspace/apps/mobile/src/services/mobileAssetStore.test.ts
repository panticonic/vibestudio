import {
  MobileAssetStore,
  type MobileStoredAsset,
  type MobileStoredAssetMetadata,
  type NativeMobileAssetStoreHost,
} from "./mobileAssetStore";

jest.mock("react-native", () => ({ NativeModules: {} }), { virtual: true });

const namespace = {
  serverIdentity: "a".repeat(64),
  workspaceIdentity: "workspace-one",
};
const metadata: MobileStoredAssetMetadata = {
  status: 200,
  statusText: "OK",
  gzip: true,
  contentType: "text/javascript",
  replayHeaders: { "cache-control": "public, max-age=31536000, immutable" },
};
const rawAsset = {
  handle: `vibestudio-asset-v1:${"b".repeat(64)}`,
  size: 3,
  metadataJson: JSON.stringify(metadata),
};
const asset: MobileStoredAsset = { handle: rawAsset.handle, size: 3, metadata };

function fakeNative(): jest.Mocked<NativeMobileAssetStoreHost> {
  return {
    assetStoreLookup: jest.fn(async () => null),
    assetStoreOpenWrite: jest.fn(async () => "write-one"),
    assetStoreAppend: jest.fn(async () => undefined),
    assetStoreCommit: jest.fn(async () => rawAsset),
    assetStoreAbort: jest.fn(async () => undefined),
    assetStoreTrim: jest.fn(async () => undefined),
    assetStoreClear: jest.fn(async () => undefined),
  };
}

describe("MobileAssetStore", () => {
  it("captures an explicit namespace on every keyed native operation", async () => {
    const native = fakeNative();
    const store = new MobileAssetStore(namespace, native);

    const acquisition = await store.acquire("/panel.js");
    expect(acquisition.kind).toBe("owner");
    const writeId = await store.openWrite("/panel.js");
    await store.append(writeId, new Uint8Array([1, 2, 3]));
    const committed = await store.commit(writeId, metadata);
    if (acquisition.kind === "owner") acquisition.complete(committed);

    expect(native.assetStoreLookup).toHaveBeenCalledWith(namespace, "/panel.js");
    expect(native.assetStoreOpenWrite).toHaveBeenCalledWith(namespace, "/panel.js");
    expect(native.assetStoreAppend).toHaveBeenCalledWith("write-one", "AQID");
    expect(committed).toEqual(asset);
  });

  it("single-flights a miss and publishes the native handle to waiters", async () => {
    const native = fakeNative();
    const store = new MobileAssetStore(namespace, native);
    const owner = await store.acquire("/panel.js");
    expect(owner.kind).toBe("owner");

    const waiter = store.acquire("/panel.js");
    await Promise.resolve();
    if (owner.kind === "owner") owner.complete(asset);

    await expect(waiter).resolves.toEqual({ kind: "hit", asset });
  });

  it("covers native lookup with the flight so a delayed stale miss cannot create a second owner", async () => {
    const native = fakeNative();
    let resolveLookup!: (value: null) => void;
    native.assetStoreLookup.mockImplementationOnce(
      () => new Promise<null>((resolve) => (resolveLookup = resolve))
    );
    const store = new MobileAssetStore(namespace, native);

    const first = store.acquire("/panel.js");
    const second = store.acquire("/panel.js");
    expect(native.assetStoreLookup).toHaveBeenCalledTimes(1);
    resolveLookup(null);
    const owner = await first;
    expect(owner.kind).toBe("owner");
    if (owner.kind === "owner") owner.complete(asset);

    await expect(second).resolves.toEqual({ kind: "hit", asset });
    expect(native.assetStoreLookup).toHaveBeenCalledTimes(1);
  });

  it("fails waiters loudly when native population fails", async () => {
    const native = fakeNative();
    const store = new MobileAssetStore(namespace, native);
    const owner = await store.acquire("/panel.js");
    const waiter = store.acquire("/panel.js");
    await Promise.resolve();
    const error = new Error("disk full");
    if (owner.kind === "owner") owner.fail(error);
    await expect(waiter).rejects.toBe(error);
  });

  it("rejects no-store metadata before native publication", async () => {
    const native = fakeNative();
    const store = new MobileAssetStore(namespace, native);
    await expect(
      store.commit("write-one", {
        ...metadata,
        replayHeaders: { "cache-control": "no-store" },
      })
    ).rejects.toThrow(/successful immutable/u);
    expect(native.assetStoreCommit).not.toHaveBeenCalled();
  });

  it("treats no-store as authoritative even when immutable is also present", async () => {
    const native = fakeNative();
    const store = new MobileAssetStore(namespace, native);
    await expect(
      store.commit("write-one", {
        ...metadata,
        replayHeaders: { "cache-control": "immutable, no-store" },
      })
    ).rejects.toThrow(/successful immutable/u);
    expect(native.assetStoreCommit).not.toHaveBeenCalled();
  });

  it("rejects native paths and malformed opaque handles", async () => {
    const native = fakeNative();
    native.assetStoreLookup.mockResolvedValue({
      ...rawAsset,
      handle: "/data/user/0/app.vibestudio.mobile/files/private.js",
    });
    const store = new MobileAssetStore(namespace, native);
    await expect(store.acquire("/panel.js")).rejects.toThrow(/invalid handle/u);
  });

  it("close waits for owned populations and rejects new work", async () => {
    const native = fakeNative();
    const store = new MobileAssetStore(namespace, native);
    const owner = await store.acquire("/panel.js");
    let closed = false;
    const close = store.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    if (owner.kind === "owner") owner.complete(null);
    await close;
    await expect(store.acquire("/other.js")).rejects.toThrow(/closing/u);
  });
});

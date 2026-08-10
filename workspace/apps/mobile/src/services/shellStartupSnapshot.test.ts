import type { PanelTreeCacheSnapshot } from "@vibestudio/shell-core/panelTreeCache";
import {
  loadMobileShellStartupSnapshot,
  saveMobileShellStartupSnapshot,
  type MobileShellStartupSnapshot,
} from "./shellStartupSnapshot";

jest.mock("react-native", () => ({ NativeModules: {} }), { virtual: true });

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: jest.fn(async (key: string) => values.get(key) ?? null),
    setItem: jest.fn(async (key: string, value: string) => {
      values.set(key, value);
    }),
    removeItem: jest.fn(async (key: string) => {
      values.delete(key);
    }),
  };
}

const tree: PanelTreeCacheSnapshot = {
  revision: 7,
  rootGroups: {
    revision: 7,
    groups: [{ ownerUserId: "user", rootCount: 0 }],
    nextCursor: null,
  },
  groups: [],
};

function snapshot(): MobileShellStartupSnapshot {
  return {
    schemaVersion: 1,
    serverIdentity: "a".repeat(64),
    workspaceIdentity: "workspace-one",
    capturedAt: 123,
    preferredPanelId: null,
    tree,
    rootPanels: [],
  };
}

describe("mobile shell startup snapshot", () => {
  it("round-trips only inside its server and workspace namespace", async () => {
    const storage = memoryStorage();
    expect(await saveMobileShellStartupSnapshot(snapshot(), storage)).toBe(true);
    await expect(
      loadMobileShellStartupSnapshot("a".repeat(64), "workspace-one", storage)
    ).resolves.toEqual(snapshot());
    await expect(
      loadMobileShellStartupSnapshot("b".repeat(64), "workspace-one", storage)
    ).resolves.toBeNull();
  });

  it("removes malformed local state instead of exposing it to startup", async () => {
    const storage = memoryStorage();
    await saveMobileShellStartupSnapshot(snapshot(), storage);
    const [storageKey] = [...storage.values.keys()];
    storage.values.set(storageKey!, JSON.stringify({ schemaVersion: 1, rootPanels: "bad" }));

    await expect(
      loadMobileShellStartupSnapshot("a".repeat(64), "workspace-one", storage)
    ).resolves.toBeNull();
    expect(storage.removeItem).toHaveBeenCalledWith(storageKey);
  });
});

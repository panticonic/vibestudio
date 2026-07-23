/**
 * The sole workspace-app boundary to React Native's device-local key/value
 * store.
 *
 * App-local persistence is runtime plumbing, like a browser app's localStorage:
 * it does not grant access to a host service or another unit. Keeping the native
 * import here gives Metro one auditable boundary and prevents feature modules
 * from acquiring arbitrary native dependencies.
 */

import AsyncStorage from "@react-native-async-storage/async-storage";

export interface NativeAppStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export function getNativeAppStorage(): NativeAppStorage {
  return AsyncStorage;
}

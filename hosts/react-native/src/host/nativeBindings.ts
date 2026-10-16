import AsyncStorage from "@react-native-async-storage/async-storage";
import Clipboard from "@react-native-clipboard/clipboard";
import { Linking, NativeEventEmitter, NativeModules, Platform } from "react-native";
import {
  consumeConnectLinkReplay,
  connectPairingFromLink,
  isConnectLink,
  markConnectLinkConsumed,
  parseConnectLink,
} from "@vibestudio/mobile-iroh/connectLink";
import {
  createGatewayArtifactFetch,
  createMobileArtifactStore,
} from "@vibestudio/mobile-iroh/bundleDelivery";
import { EventsClient } from "@vibestudio/service-schemas/clients/eventsClient";
import type { DeviceCapabilityPorts } from "./clientInstance";
import type { HostLinkPorts, HostRuntimePorts } from "./hostRuntime";
import { createDevicePorts } from "./deviceConnection";
import { HostState } from "./hostState";
import {
  HOST_RUNTIME_EVENT,
  HOST_RUNTIME_MODULE,
  type HostRuntimeEvent,
  type HostRuntimeNativeModule,
} from "./nativeHostRuntime";
import { createHostNotifications } from "./notifications/hostNotifications";
import { createNativeNotificationPorts } from "./notifications/nativePorts";
import type { KeyValueStore } from "./ports";
import { HostRuntime } from "./hostRuntime";

interface MobileHostNative {
  consumeUsbProvisioningApproval?(url: string): Promise<boolean>;
  openSafariBrowserDataExport: DeviceCapabilityPorts["browserImport"]["openSafariExport"];
  pickBrowserImportArchive: DeviceCapabilityPorts["browserImport"]["pickArchive"];
  readBrowserImportEntry: DeviceCapabilityPorts["browserImport"]["readEntry"];
  releaseBrowserImportArchive: DeviceCapabilityPorts["browserImport"]["releaseArchive"];
}

function requireModule<T>(name: string): T {
  const module = NativeModules[name] as T | undefined;
  if (!module) throw new Error(`The ${name} native module is not installed`);
  return module;
}

export function asyncStorageKeyValueStore(): KeyValueStore {
  return {
    get: (key) => AsyncStorage.getItem(key),
    set: (key, value) => AsyncStorage.setItem(key, value),
    remove: (key) => AsyncStorage.removeItem(key),
    keys: async (prefix) => (await AsyncStorage.getAllKeys()).filter((key) => key.startsWith(prefix)),
  };
}

const OPENABLE_SCHEMES = /^(https?|mailto):/iu;

/**
 * Start the host runtime on this device's real modules. Called once from the
 * app entry, at process start, before any component renders.
 */
export function startMobileHost(options: {
  hostVersion: string;
  smokePhase?: (phase: string) => void;
}): HostRuntime {
  const native = requireModule<HostRuntimeNativeModule>(HOST_RUNTIME_MODULE);
  const mobileHost = requireModule<MobileHostNative>("VibestudioMobileHost");
  const emitter = new NativeEventEmitter(NativeModules[HOST_RUNTIME_MODULE]);
  const platform = Platform.OS === "ios" ? "ios" : "android";

  const links: HostLinkPorts = {
    isConnectLink: (url) => isConnectLink(url),
    parseConnectLink(url) {
      const parsed = parseConnectLink(url);
      if (parsed.kind === "error") throw new Error(parsed.reason);
      return connectPairingFromLink(parsed);
    },
    consumeReplay: consumeConnectLinkReplay,
    markConsumed: markConnectLinkConsumed,
    consumeUsbApproval: async (url) =>
      Boolean(await mobileHost.consumeUsbProvisioningApproval?.(url)),
  };

  const deviceCapabilities: DeviceCapabilityPorts = {
    setClipboard: async (text) => Clipboard.setString(text),
    async openExternal(url) {
      if (!OPENABLE_SCHEMES.test(url)) {
        throw new Error("Only http, https and mailto links can be opened outside Vibestudio.");
      }
      await Linking.openURL(url);
    },
    browserImport: {
      openSafariExport: () => mobileHost.openSafariBrowserDataExport(),
      pickArchive: () => mobileHost.pickBrowserImportArchive(),
      readEntry: (handle, name, offset, maxBytes) =>
        mobileHost.readBrowserImportEntry(handle, name, offset, maxBytes),
      releaseArchive: (handle) => mobileHost.releaseBrowserImportArchive(handle),
    },
  };

  let runtime: HostRuntime | null = null;
  const notifications = createHostNotifications({
    ...createNativeNotificationPorts(),
    decide: (target, decision) => {
      if (!runtime) return Promise.reject(new Error("The host runtime has not started."));
      return runtime.decideApproval(target, decision);
    },
  });

  const ports: HostRuntimePorts = {
    native,
    onNativeEvent(handler) {
      const subscription = emitter.addListener(HOST_RUNTIME_EVENT, (payload: string) =>
        handler(JSON.parse(payload) as HostRuntimeEvent)
      );
      return () => subscription.remove();
    },
    device: createDevicePorts({
      oauthCallbackMode: Platform.OS === "ios" ? "app-scheme" : "client-loopback",
      ...(options.smokePhase ? { smokePhase: options.smokePhase } : {}),
    }),
    events: (connection) => new EventsClient(connection.launch.rpc, connection.recovery),
    artifactStore: createMobileArtifactStore(native),
    artifactFetch: (connection) => createGatewayArtifactFetch(connection.launch.rpc),
    state: new HostState(asyncStorageKeyValueStore()),
    deviceCapabilities,
    notifications,
    links,
    linkSource: {
      onUrl(handler) {
        const subscription = Linking.addEventListener("url", (event) => handler(event.url));
        return () => subscription.remove();
      },
      initialUrl: () => Linking.getInitialURL(),
    },
    platform,
    hostVersion: options.hostVersion,
    ...(options.smokePhase ? { smokePhase: options.smokePhase } : {}),
  };
  runtime = new HostRuntime(ports);
  return runtime;
}

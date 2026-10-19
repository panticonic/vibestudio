/**
 * The native side of the mobile host runtime (docs/client-hosts-and-clients-plan.md §5.3).
 *
 * The host runtime is the headless React Native instance that owns the device.
 * It starts with the process (Android `Application.onCreate`, iOS app delegate),
 * before any activity or scene and independent of which client the OS is about
 * to show. Each client runs in its own RN instance that native code creates
 * from a verified bundle file. Native owns exactly three things here:
 *
 *  1. Instances: create, reload, stop and show client RN instances, and the
 *     artifact store that holds verified client bundles.
 *  2. The broker: carry JSON between a client instance and the host runtime.
 *     Native never interprets a request; the host runtime's capability broker
 *     decides what a client may do (`hosts/react-native/src/host/clientBroker.ts`).
 *  3. Integrity at the last moment: native re-hashes a bundle file against the
 *     integrity it was given immediately before it creates an instance, and
 *     refuses to load it on mismatch, whatever the host runtime believed.
 *
 * Module `VibestudioHostRuntime` exists in the HOST instance only. A client
 * instance gets `VibestudioClientBroker` instead (see `CLIENT_BROKER_MODULE`
 * in `@vibestudio/rn-client-api/protocol`), constructed with that instance's
 * tag, so a client cannot name another client. Client instances do not
 * register the raw device modules at all: react-native-keychain,
 * @react-native-firebase/*, @notifee/react-native,
 * @react-native-async-storage/async-storage, VibestudioIroh,
 * VibestudioMobileHost, VibestudioHostRuntime. The panel-hosting natives a
 * browser needs (`WorkspaceWebView`, the asset store and cookie clearing in
 * module `VibestudioPanelHost`, react-native-tcp-socket, react-native-webview)
 * are registered in a client instance only when `panel-hosting` is granted.
 * Starting a client runs the component `CLIENT_ROOT_COMPONENT`.
 */
import type { LaunchSurfaces } from "./integration";

export const HOST_RUNTIME_MODULE = "VibestudioHostRuntime";
/** The host's own root component (pairing, review, messages): `app.json` `name`, started by MainActivity / the first scene. */
export const HOST_ROOT_COMPONENT = "Vibestudio";
/** Device event name; payload is one JSON string of a {@link HostRuntimeEvent}. */
export const HOST_RUNTIME_EVENT = "VibestudioHostRuntimeEvent";

/** A bundle the host has verified, ready to run. */
export interface NativeClientBundle {
  /** Absolute path of the verified primary bundle inside the materialized build directory. */
  bundlePath: string;
  /** `sha256-<hex>` of the bundle file; native re-verifies before loading. */
  integrity: string;
  buildKey: string;
  /** The materialized build directory (`artifactMaterializeBuild`): the bundle's assets live beside it. */
  assetsRoot: string;
}

export interface NativeClientSpec extends NativeClientBundle {
  /** Instance tag: the client principal id, `client:<id>:react-native:<deviceId>`. */
  tag: string;
  clientId: string;
  title: string;
  /** Granted capabilities; native registers a capability's native modules only when it is granted (`panel-hosting` for the WebView stack). */
  grantedCapabilities: string[];
}

export type ClientStopReason =
  | "trust-revoked"
  | "capability-revoked"
  | "device-reset"
  | "closed"
  | "failed";

export interface HostRuntimeNativeModule {
  /**
   * The host runtime has attached its event listeners and can serve client
   * requests. Native holds client requests (and client activities waiting on
   * the host) until this is called; there is no delay or timeout, only this
   * readiness event.
   */
  markReady(): Promise<void>;

  /**
   * Create the client's RN instance from `spec` and show it (Android: its own
   * Recents task, `FLAG_ACTIVITY_NEW_DOCUMENT | FLAG_ACTIVITY_MULTIPLE_TASK`,
   * label `spec.title`; iOS: the scene's root view). Resolves when the client's
   * JavaScript has started; rejects with the native failure otherwise, and
   * with an integrity error before anything is loaded when the file does not
   * match `spec.integrity`. Starting a tag that already runs reloads it.
   */
  startClient(spec: NativeClientSpec): Promise<void>;

  /**
   * Reload only this client's instance onto another verified bundle (an
   * adopted update or a rollback). Same verification and resolution as start.
   */
  reloadClient(tag: string, bundle: NativeClientBundle): Promise<void>;

  /** Destroy the client's instance and close its task or view. Never fails for an unknown tag. */
  stopClient(tag: string, reason: ClientStopReason): Promise<void>;

  /** Bring a running client to the front. */
  focusClient(tag: string): Promise<void>;

  /** Bring the host's own surface (pairing, review, messages) to the front. */
  showHostSurface(): Promise<void>;

  /**
   * Ask the launcher to pin a shortcut that opens `link` (a
   * `vibestudio://c/<id>/<intent>` link): Android `ShortcutManagerCompat.requestPinShortcut`.
   * The OS confirms with the person. Resolves false when the launcher cannot
   * pin shortcuts; rejects when the request is malformed.
   */
  requestPinShortcut(shortcutId: string, label: string, link: string): Promise<boolean>;

  /**
   * Replace what the OS shows of the launch surfaces with `surfaces` (the host
   * publishes the whole set after every refresh; see `LaunchSurfaces`).
   * Android: dynamic shortcuts and the widget's data. iOS: the App Group
   * snapshot the App Intents, widgets and share extension read, quick actions,
   * and `updateAppShortcutParameters()`. Resolves once the OS has the new set.
   */
  publishLaunchSurfaces(surfaces: LaunchSurfaces): Promise<void>;

  /**
   * Disable pinned launchers whose client is gone, so tapping one says
   * `message` instead of opening nothing (Android
   * `ShortcutManagerCompat.disableShortcuts`; a pinned shortcut cannot be
   * removed programmatically). iOS has no pinned launchers and resolves.
   */
  disablePinnedShortcuts(shortcutIds: string[], message: string): Promise<void>;

  /** Answer a `client-request` with the JSON result (`"null"` for void). */
  respond(tag: string, requestId: string, resultJson: string): Promise<void>;
  /** Fail a `client-request`; the client sees an Error with `code` and `message`. */
  reject(tag: string, requestId: string, code: string, message: string): Promise<void>;
  /** Deliver one event (`ClientHostEvent` JSON) to the client's instance. A stopped tag drops it. */
  emit(tag: string, eventJson: string): Promise<void>;

  // --- The verified artifact store (ClientArtifactStore, `sha256-<hex>` keyed) ---
  artifactHas(integrity: string): Promise<boolean>;
  /** Start a write; bytes accumulate in staging, invisible to readers. */
  artifactBeginWrite(integrity: string, name: string): Promise<string>;
  artifactAppend(writeId: string, bytesBase64: string): Promise<void>;
  /**
   * Hash the staged bytes; when they match the declared integrity publish
   * them atomically (a reader never sees a partial artifact), otherwise
   * discard them and reject with code `integrity-mismatch`. Concurrent
   * writers of one integrity are fine.
   */
  artifactCommit(writeId: string): Promise<void>;
  artifactAbort(writeId: string): Promise<void>;
  artifactList(): Promise<string[]>;
  artifactRemove(integrity: string): Promise<void>;
  /** Absolute path of a stored artifact (rejects when absent). */
  artifactLocate(integrity: string): Promise<string>;
  /** The whole stored artifact, base64 (small artifacts only). */
  artifactRead(integrity: string): Promise<string>;
  /**
   * Lay one build's verified artifacts out as the tree its bundle expects
   * (React Native resolves a bundle's assets relative to the bundle file):
   * `<buildsRoot>/<buildKey>/<path>` for every entry, hard-linked or copied
   * from the store, each hashed against its integrity as it is placed.
   * Rejects (laying nothing visible) when any entry is absent or mismatched.
   * Returns the build's directory. Idempotent for the same entries.
   */
  artifactMaterializeBuild(
    buildKey: string,
    entries: Array<{ path: string; integrity: string }>
  ): Promise<string>;
  /** Remove every materialized build directory not named in `keep`. */
  artifactRetainBuilds(keep: string[]): Promise<void>;
}

export type HostRuntimeEvent =
  /**
   * Android: whether any of the app's activities (the host's screen or a
   * client's task) is in the foreground. Native sends it when the host runtime
   * becomes ready and on every change. The device connections follow it rather
   * than the host screen's own lifecycle, which pauses whenever a client is in front.
   */
  | { type: "process-foreground"; foreground: boolean }
  /** A client instance called its broker. Reply with `respond` or `reject`. */
  | { type: "client-request"; tag: string; requestId: string; method: string; argsJson: string }
  /**
   * The client's instance changed state outside the host's own calls:
   * `stopped` when the person closed its task, `crashed` on a fatal JS or
   * native error (native has already torn the instance down).
   */
  | { type: "client-lifecycle"; tag: string; state: "stopped" | "crashed"; message?: string }
  /**
   * The OS entered the process through a client's task (Android: a restored or
   * pinned task) and there is no live instance for `tag`. The host launches
   * the client again; native has its activity wait for that.
   */
  | { type: "client-restore"; tag: string; clientId: string }
  /**
   * The OS delivered a `vibestudio://c/...` link (a pinned shortcut, a launcher
   * menu, a bubble) to the host's link activity; it is handled like any client
   * link. `focus: false` delivers the intent without bringing the client's
   * task forward (a bubble shows the client itself).
   */
  | { type: "link"; url: string; focus?: boolean }
  /** Text was shared into Vibestudio (Android `ACTION_SEND`); `mimeType` is what the sender declared. */
  | { type: "share-in"; mimeType: string; text: string }
  /**
   * A launch surface (a Quick Settings tile, an App Intent) asked to run
   * background intent `name` with this text, of client `clientId` when the
   * surface named one.
   */
  | { type: "background-intent"; name: string; text: string; clientId?: string }
  /**
   * The launcher confirmed a pinned shortcut the host requested with
   * `requestPinShortcut`. This is the only signal that the person said yes.
   */
  | { type: "shortcut-pinned"; shortcutId: string; label: string; link: string }
  /**
   * The person used a notification native drew itself (Android conversation
   * notifications): pressed it, or answered one of its actions (`input` is
   * what they typed into a reply field). `data` is what the host gave native
   * to attach when it displayed the notification.
   */
  | {
      type: "notification-event";
      kind: "press" | "action";
      actionId?: string;
      input?: string;
      data: Record<string, string>;
    };

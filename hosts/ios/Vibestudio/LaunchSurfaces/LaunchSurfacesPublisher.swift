import AppIntents
import UIKit
import WidgetKit

/// Events for the host runtime's JavaScript from native launch surfaces
/// (`link`, `share-in`, `background-intent` in `HostRuntimeEvent`).
///
/// The Objective-C `VibestudioClientManager` installs `sink` when the host
/// instance starts, and the manager holds what it is given until the host
/// runtime calls `markReady`. App Intents can run before that sink exists
/// only if the process is entered by an intent ahead of the app delegate;
/// events produced then wait here until the sink is installed (no timer).
@objc(VibestudioLaunchEvents)
final class LaunchEvents: NSObject {
  private static var undelivered: [String] = []

  @objc static var sink: ((String) -> Void)? {
    didSet {
      guard let sink else { return }
      let waiting = undelivered
      undelivered = []
      waiting.forEach(sink)
    }
  }

  private static func deliver(_ json: String) {
    if let sink { sink(json) } else { undelivered.append(json) }
  }

  static func emit(_ event: [String: String]) throws {
    let json = String(decoding: try JSONSerialization.data(withJSONObject: event), as: UTF8.self)
    if Thread.isMainThread { deliver(json) } else { DispatchQueue.main.async { deliver(json) } }
  }

  static func link(_ url: String) throws {
    try emit(["type": "link", "url": url])
  }

  static func backgroundIntent(name: String, text: String, clientId: String) throws {
    try emit(["type": "background-intent", "name": name, "text": text, "clientId": clientId])
  }

  /// Emits a `share-in` event for each item the share extension left, oldest
  /// first, deleting an item once the sink accepted it. Main thread only.
  @objc static func ingestShareInbox() {
    do {
      try ShareInbox.shared().drain { item in
        try emit(["type": "share-in", "mimeType": item.mimeType, "text": item.text])
      }
    } catch {
      NSLog("[Vibestudio] share-inbox ingest failed: %@", "\(error)")
    }
  }
}

/// Projects the published snapshot onto the OS: the App Group file the
/// intents, widgets and share extension read, home-screen quick actions, the
/// App Shortcuts parameter list, and the widget timelines.
@objc(VibestudioLaunchSurfacesPublisher)
final class LaunchSurfacesPublisher: NSObject {
  static let quickActionType = "app.vibestudio.launch"

  @objc static func publish(_ json: String, completion: @escaping (NSError?) -> Void) {
    do {
      let surfaces = try LaunchSnapshotStore.shared().write(Data(json.utf8))
      DispatchQueue.main.async {
        UIApplication.shared.shortcutItems = surfaces.quickActions().map { action in
          UIApplicationShortcutItem(
            type: quickActionType,
            localizedTitle: action.title,
            localizedSubtitle: nil,
            icon: nil,
            userInfo: ["link": action.link as NSString]
          )
        }
        VibestudioShortcuts.updateAppShortcutParameters()
        WidgetCenter.shared.reloadAllTimelines()
        completion(nil)
      }
    } catch {
      completion(error as NSError)
    }
  }
}

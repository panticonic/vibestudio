import Foundation

enum LaunchStoreError: Error, LocalizedError {
  case noAppGroup

  var errorDescription: String? {
    "Vibestudio's App Group is not available to this process."
  }
}

/// The App Group container the host runtime writes the snapshot into and the
/// intents, widgets and share extension read. Each target's Info.plist names
/// the group in `VibestudioAppGroup` (`group.$(VIBESTUDIO_IOS_BUNDLE_ID)`), so
/// a locally overridden bundle id keeps app and extensions on one group.
/// Compiled into the app, the widget extension and the share extension.
struct LaunchSnapshotStore {
  static let fileName = "launch-surfaces.json"
  let directory: URL

  static func shared() throws -> LaunchSnapshotStore {
    try LaunchSnapshotStore(directory: appGroupContainer())
  }

  static func appGroupContainer() throws -> URL {
    guard
      let group = Bundle.main.object(forInfoDictionaryKey: "VibestudioAppGroup") as? String,
      let url = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: group)
    else { throw LaunchStoreError.noAppGroup }
    return url
  }

  private var fileURL: URL { directory.appendingPathComponent(Self.fileName) }

  /// Nothing published yet reads as the empty set; a present but undecodable file throws.
  func read() throws -> LaunchSurfaces {
    guard FileManager.default.fileExists(atPath: fileURL.path) else { return .empty }
    return try JSONDecoder().decode(LaunchSurfaces.self, from: Data(contentsOf: fileURL))
  }

  /// Validates `json` as a snapshot, then replaces the file atomically (readers never see a partial write).
  @discardableResult
  func write(_ json: Data) throws -> LaunchSurfaces {
    let surfaces = try JSONDecoder().decode(LaunchSurfaces.self, from: json)
    try json.write(to: fileURL, options: .atomic)
    return surfaces
  }
}

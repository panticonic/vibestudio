import Foundation

struct ShareInboxItem: Codable, Equatable {
  let id: String
  /// Seconds since 1970; orders the inbox.
  let createdAt: Double
  let mimeType: String
  let text: String
}

/// The App Group directory the share extension drops items into and the host
/// ingests on its next activation. The extension never dials the server (it
/// would supersede the app's connection); this directory is the whole handoff.
/// Compiled into the app and the share extension.
struct ShareInbox {
  let directory: URL

  static func shared() throws -> ShareInbox {
    ShareInbox(directory: try LaunchSnapshotStore.appGroupContainer().appendingPathComponent("ShareInbox", isDirectory: true))
  }

  /// Oldest first; ties by id so ingestion order is total.
  static func ordered<T>(_ entries: [(T, ShareInboxItem)]) -> [(T, ShareInboxItem)] {
    entries.sorted { ($0.1.createdAt, $0.1.id) < ($1.1.createdAt, $1.1.id) }
  }

  @discardableResult
  func enqueue(mimeType: String, text: String, now: Date = Date()) throws -> ShareInboxItem {
    let item = ShareInboxItem(id: UUID().uuidString.lowercased(), createdAt: now.timeIntervalSince1970, mimeType: mimeType, text: text)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    try JSONEncoder().encode(item).write(to: directory.appendingPathComponent("\(item.id).json"), options: .atomic)
    return item
  }

  /// Calls `emit` for each pending item, oldest first, and deletes an item's
  /// file only after `emit` returned for it. A throwing `emit` stops the drain
  /// and leaves that item and every later one in place. An undecodable file
  /// can never be delivered, so it is deleted and reported.
  func drain(emit: (ShareInboxItem) throws -> Void) throws {
    guard FileManager.default.fileExists(atPath: directory.path) else { return }
    var entries: [(URL, ShareInboxItem)] = []
    for file in try FileManager.default.contentsOfDirectory(at: directory, includingPropertiesForKeys: nil) where file.pathExtension == "json" {
      do {
        entries.append((file, try JSONDecoder().decode(ShareInboxItem.self, from: Data(contentsOf: file))))
      } catch {
        NSLog("[Vibestudio] dropping unreadable share-inbox file %@: %@", file.lastPathComponent, "\(error)")
        try FileManager.default.removeItem(at: file)
      }
    }
    for (file, item) in Self.ordered(entries) {
      try emit(item)
      try FileManager.default.removeItem(at: file)
    }
  }
}

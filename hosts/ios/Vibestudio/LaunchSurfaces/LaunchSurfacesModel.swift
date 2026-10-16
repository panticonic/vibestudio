import Foundation

// The launch-surface snapshot the host runtime publishes after every refresh
// (`LaunchSurfaces` in hosts/react-native/src/host/integration.ts). One format:
// the App Intents, quick actions, widgets and the share extension all decode
// this and nothing else. This file is compiled into the app, the widget
// extension and the share extension.

struct LaunchItem: Codable, Equatable {
  let intent: String
  let label: String
  let link: String
}

struct LaunchClient: Codable, Equatable {
  let clientId: String
  let title: String
  /// Plain foreground intents, `open` first.
  let shortcuts: [LaunchItem]
  /// Dynamic entries of parameterized foreground intents (recent conversations).
  let recent: [LaunchItem]
}

struct BackgroundEntry: Codable, Equatable {
  let clientId: String
  let clientTitle: String
  let intent: String
  let title: String
  let textParam: String
}

struct ShareInEntry: Codable, Equatable {
  let clientId: String
  let clientTitle: String
  let intent: String
  let textParam: String
  let accepts: [String]
}

struct LaunchSurfaces: Codable, Equatable {
  let clients: [LaunchClient]
  let background: [BackgroundEntry]
  let shareIn: [ShareInEntry]

  static let empty = LaunchSurfaces(clients: [], background: [], shareIn: [])

  func client(_ clientId: String) -> LaunchClient? {
    clients.first { $0.clientId == clientId }
  }

  /// The link that opens a client: its `open` shortcut, else its first shortcut.
  func openLink(clientId: String) -> String? {
    guard let client = client(clientId) else { return nil }
    return (client.shortcuts.first { $0.intent == "open" } ?? client.shortcuts.first)?.link
  }

  /// Every launchable item with its client: shortcuts first, then recent entries.
  var launchItems: [(client: LaunchClient, item: LaunchItem)] {
    clients.flatMap { client in (client.shortcuts + client.recent).map { (client: client, item: $0) } }
  }

  /// The background intent an Ask targets: the named client's, else the first declared.
  func askEntry(clientId: String?) -> BackgroundEntry? {
    guard let clientId else { return background.first }
    return background.first { $0.clientId == clientId }
  }
}

// MARK: Home-screen quick actions

struct QuickAction: Equatable {
  let title: String
  let link: String
}

extension LaunchSurfaces {
  /// iOS shows four quick actions comfortably (the system allows more but clips).
  static let quickActionLimit = 4

  /// Round-robin across clients so each gets its first shortcut (`open`)
  /// before any client gets a second; deterministic in snapshot order.
  func quickActions(limit: Int = LaunchSurfaces.quickActionLimit) -> [QuickAction] {
    var actions: [QuickAction] = []
    var depth = 0
    while actions.count < limit {
      let column = clients.compactMap { client in
        depth < client.shortcuts.count ? (client, client.shortcuts[depth]) : nil
      }
      if column.isEmpty { break }
      for (client, item) in column {
        let title = item.intent == "open" ? client.title : "\(client.title): \(item.label)"
        actions.append(QuickAction(title: title, link: item.link))
        if actions.count == limit { break }
      }
      depth += 1
    }
    return actions
  }
}

// MARK: Share routing

extension LaunchSurfaces {
  /// The share-in entries that accept `mimeType` (`text/*`, `*/*` and exact types).
  func shareTargets(mimeType: String) -> [ShareInEntry] {
    shareIn.filter { Self.accepts($0.accepts, mimeType: mimeType) }
  }

  static func accepts(_ patterns: [String], mimeType: String) -> Bool {
    let mime = mimeType.lowercased()
    return patterns.contains { raw in
      let pattern = raw.lowercased()
      if pattern == "*/*" || pattern == "*" { return true }
      if pattern.hasSuffix("/*") { return mime.hasPrefix(pattern.dropLast()) }
      return pattern == mime
    }
  }
}

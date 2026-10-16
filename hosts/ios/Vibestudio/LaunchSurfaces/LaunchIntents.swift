import AppIntents

// Generic App Intents compiled into the host once (docs/client-hosts-and-clients-plan.md §5.4).
// They live in the app target, not an App Intents extension: the app itself
// must call `updateAppShortcutParameters()` on the provider.

enum LaunchIntentError: Error, CustomLocalizedStringResourceConvertible {
  case unknownClient(String)
  case noAsk
  case mismatchedAction(String)

  var localizedStringResource: LocalizedStringResource {
    switch self {
    case .unknownClient(let name): "\(name) has nothing to open."
    case .noAsk: "No client in Vibestudio accepts questions."
    case .mismatchedAction(let name): "That action does not belong to \(name)."
    }
  }
}

/// A launchable item of a client (its `open` and the dynamic entries); the id is its link.
struct ClientIntentEntity: AppEntity {
  static let typeDisplayRepresentation: TypeDisplayRepresentation = "Client Action"
  static var defaultQuery = ClientIntentQuery()

  let id: String
  let label: String
  let clientId: String
  let clientTitle: String

  var displayRepresentation: DisplayRepresentation {
    DisplayRepresentation(title: "\(label)", subtitle: "\(clientTitle)")
  }
}

struct ClientIntentQuery: EntityQuery {
  private func all() throws -> [ClientIntentEntity] {
    try LaunchSnapshotStore.shared().read().launchItems.map {
      ClientIntentEntity(id: $0.item.link, label: $0.item.label, clientId: $0.client.clientId, clientTitle: $0.client.title)
    }
  }

  func entities(for identifiers: [String]) async throws -> [ClientIntentEntity] {
    try all().filter { identifiers.contains($0.id) }
  }

  func suggestedEntities() async throws -> [ClientIntentEntity] {
    try all()
  }
}

/// Foreground: the app comes up and the host runtime handles the link like any client link.
struct OpenClientIntent: AppIntent {
  static var title: LocalizedStringResource = "Open Client"
  static var description = IntentDescription("Opens a client in Vibestudio.")
  static var openAppWhenRun: Bool = true

  @Parameter(title: "Client")
  var client: ClientEntity

  @Parameter(title: "Action")
  var intent: ClientIntentEntity?

  func perform() async throws -> some IntentResult {
    if let intent, intent.clientId != client.id { throw LaunchIntentError.mismatchedAction(client.title) }
    let link = try intent?.id ?? LaunchSnapshotStore.shared().read().openLink(clientId: client.id)
    guard let link else { throw LaunchIntentError.unknownClient(client.title) }
    try LaunchEvents.link(link)
    return .result()
  }
}

/// Background: runs in the app process, possibly with no scene. The headless
/// host runtime serves the intent on the server and shows the answer as a
/// notification, so the result here only acknowledges.
struct AskIntent: AppIntent {
  static var title: LocalizedStringResource = "Ask Vibestudio"
  static var description = IntentDescription("Asks a Vibestudio client a question; the answer arrives as a notification.")

  @Parameter(title: "Client")
  var client: ClientEntity?

  @Parameter(title: "Prompt", requestValueDialog: "What do you want to ask?")
  var prompt: String

  func perform() async throws -> some IntentResult & ProvidesDialog {
    guard let entry = try LaunchSnapshotStore.shared().read().askEntry(clientId: client?.id) else {
      throw LaunchIntentError.noAsk
    }
    try LaunchEvents.backgroundIntent(name: entry.intent, text: prompt, clientId: entry.clientId)
    return .result(dialog: "Asking \(entry.clientTitle)…")
  }
}

struct VibestudioShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: AskIntent(),
      phrases: ["Ask \(.applicationName)", "Ask \(.applicationName) a question"],
      shortTitle: "Ask",
      systemImageName: "text.bubble"
    )
    AppShortcut(
      intent: OpenClientIntent(),
      phrases: ["Open \(\.$client) in \(.applicationName)"],
      shortTitle: "Open Client",
      systemImageName: "macwindow"
    )
  }
}

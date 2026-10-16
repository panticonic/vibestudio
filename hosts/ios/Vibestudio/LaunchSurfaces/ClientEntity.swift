import AppIntents

/// A client as the system lists it. Titles are the client names (stable; the
/// Siri Suggestions surface keeps a stale parameter title otherwise), never
/// volatile data such as a conversation preview. Compiled into the app and
/// the widget extension (widget and control configuration).
struct ClientEntity: AppEntity {
  static let typeDisplayRepresentation: TypeDisplayRepresentation = "Client"
  static var defaultQuery = ClientQuery()

  let id: String
  let title: String

  init(_ client: LaunchClient) {
    id = client.clientId
    title = client.title
  }

  var displayRepresentation: DisplayRepresentation {
    DisplayRepresentation(title: "\(title)")
  }
}

struct ClientQuery: EntityQuery {
  func entities(for identifiers: [String]) async throws -> [ClientEntity] {
    try LaunchSnapshotStore.shared().read().clients
      .filter { identifiers.contains($0.clientId) }
      .map(ClientEntity.init)
  }

  func suggestedEntities() async throws -> [ClientEntity] {
    try LaunchSnapshotStore.shared().read().clients.map(ClientEntity.init)
  }
}

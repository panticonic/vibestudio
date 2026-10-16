import AppIntents
import SwiftUI
import WidgetKit

// The widget extension reads the App Group snapshot the host runtime
// publishes; it never talks to the server. Taps open `vibestudio://c/...`
// links, which the app delivers to the host runtime like any client link.
// Sources shared with the app: LaunchSurfacesModel.swift,
// LaunchSnapshotStore.swift, ClientEntity.swift.

@main
struct VibestudioWidgets: WidgetBundle {
  @WidgetBundleBuilder
  var body: some Widget {
    ClientWidget()
    if #available(iOS 18.0, *) {
      ClientControl()
    }
  }
}

// MARK: Home-screen widget

struct ClientWidgetIntent: WidgetConfigurationIntent {
  static var title: LocalizedStringResource = "Client"
  static var description = IntentDescription("Choose the client this widget shows.")

  @Parameter(title: "Client")
  var client: ClientEntity?
}

struct ClientEntry: TimelineEntry {
  let date: Date
  let title: String
  let openURL: URL?
  let recent: [(label: String, url: URL)]
  /// Why there is nothing to show (no client published yet, unreadable snapshot).
  let message: String?
}

struct ClientProvider: AppIntentTimelineProvider {
  func placeholder(in context: Context) -> ClientEntry {
    ClientEntry(date: Date(), title: "Vibestudio", openURL: nil, recent: [], message: nil)
  }

  func snapshot(for configuration: ClientWidgetIntent, in context: Context) async -> ClientEntry {
    entry(for: configuration)
  }

  /// The host reloads timelines when it publishes a new snapshot; nothing else changes the data.
  func timeline(for configuration: ClientWidgetIntent, in context: Context) async -> Timeline<ClientEntry> {
    Timeline(entries: [entry(for: configuration)], policy: .never)
  }

  private func entry(for configuration: ClientWidgetIntent) -> ClientEntry {
    do {
      let surfaces = try LaunchSnapshotStore.shared().read()
      guard let client = configuration.client.flatMap({ surfaces.client($0.id) }) ?? surfaces.clients.first else {
        return ClientEntry(date: Date(), title: "Vibestudio", openURL: nil, recent: [], message: "Open Vibestudio to set up a client.")
      }
      return ClientEntry(
        date: Date(),
        title: client.title,
        openURL: surfaces.openLink(clientId: client.clientId).flatMap(URL.init(string:)),
        recent: client.recent.compactMap { item in URL(string: item.link).map { (label: item.label, url: $0) } },
        message: nil
      )
    } catch {
      return ClientEntry(date: Date(), title: "Vibestudio", openURL: nil, recent: [], message: error.localizedDescription)
    }
  }
}

struct ClientWidgetView: View {
  let entry: ClientEntry

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(entry.title).font(.headline)
      if let message = entry.message {
        Text(message).font(.caption).foregroundStyle(.secondary)
      }
      // `Link` works in medium and larger families; a small widget has the widgetURL.
      ForEach(Array(entry.recent.prefix(3).enumerated()), id: \.offset) { _, item in
        Link(destination: item.url) {
          Text(item.label).font(.subheadline).lineLimit(1)
        }
      }
      Spacer(minLength: 0)
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .widgetURL(entry.openURL)
    .containerBackground(.fill.tertiary, for: .widget)
  }
}

struct ClientWidget: Widget {
  var body: some WidgetConfiguration {
    AppIntentConfiguration(kind: "app.vibestudio.client", intent: ClientWidgetIntent.self, provider: ClientProvider()) { entry in
      ClientWidgetView(entry: entry)
    }
    .configurationDisplayName("Vibestudio Client")
    .description("Open a client or jump to its recent items.")
    .supportedFamilies([.systemSmall, .systemMedium])
  }
}

// MARK: Control Center control (iOS 18)

@available(iOS 18.0, *)
struct ClientControlIntent: ControlConfigurationIntent {
  static var title: LocalizedStringResource = "Client"

  @Parameter(title: "Client")
  var client: ClientEntity?
}

/// Widgets and controls have no text input, so the control opens the client,
/// whose composer takes the question. Typed Ask is the Siri / Shortcuts /
/// Action button `AskIntent`.
@available(iOS 18.0, *)
struct ClientControl: ControlWidget {
  struct Value: Sendable {
    let title: String
    let url: URL
  }

  /// With no client published the control opens the app itself.
  private static let appURL = URL(string: "vibestudio://")!

  struct Provider: AppIntentControlValueProvider {
    func previewValue(configuration: ClientControlIntent) -> Value {
      Value(title: "Vibestudio", url: ClientControl.appURL)
    }

    func currentValue(configuration: ClientControlIntent) async throws -> Value {
      let surfaces = try LaunchSnapshotStore.shared().read()
      guard let client = configuration.client.flatMap({ surfaces.client($0.id) }) ?? surfaces.clients.first,
        let url = surfaces.openLink(clientId: client.clientId).flatMap(URL.init(string:))
      else { return previewValue(configuration: configuration) }
      return Value(title: client.title, url: url)
    }
  }

  var body: some ControlWidgetConfiguration {
    AppIntentControlConfiguration(kind: "app.vibestudio.client-control", provider: Provider()) { value in
      ControlWidgetButton(action: OpenURLIntent(value.url)) {
        Label(value.title, systemImage: "text.bubble")
      }
    }
    .displayName("Open Vibestudio Client")
    .description("Opens a client so you can ask or continue.")
  }
}

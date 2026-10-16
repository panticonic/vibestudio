import SwiftUI
import UIKit
import UniformTypeIdentifiers
import UserNotifications

// Share extension: names the clients that accept the item from the App Group
// snapshot, drops the item into the App Group inbox and posts a local
// notification. It never dials the server (that would supersede the app's
// connection); the host ingests the inbox on its next activation.
// Sources shared with the app: LaunchSurfacesModel.swift,
// LaunchSnapshotStore.swift, ShareInbox.swift.

/// Shared text and URLs both travel as `text/plain`; a URL is its string.
private let sharedMimeType = "text/plain"

private enum ShareError: LocalizedError {
  case nothingToShare

  var errorDescription: String? { "Nothing in this share can be sent to Vibestudio." }
}

final class ShareViewController: UIViewController {
  override func viewDidLoad() {
    super.viewDidLoad()
    Task { @MainActor in
      do {
        let text = try await sharedText()
        let targets = try LaunchSnapshotStore.shared().read().shareTargets(mimeType: sharedMimeType)
        show(text: text, targets: targets)
      } catch {
        extensionContext?.cancelRequest(withError: error)
      }
    }
  }

  private func sharedText() async throws -> String {
    let providers = (extensionContext?.inputItems as? [NSExtensionItem] ?? []).flatMap { $0.attachments ?? [] }
    for provider in providers {
      if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
        let url = try await provider.loadItem(forTypeIdentifier: UTType.url.identifier) as? URL {
        return url.absoluteString
      }
      if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
        let text = try await provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) as? String {
        return text
      }
    }
    throw ShareError.nothingToShare
  }

  @MainActor
  private func show(text: String, targets: [ShareInEntry]) {
    let names = Array(Set(targets.map(\.clientTitle))).sorted()
    let host = UIHostingController(rootView: ShareView(
      text: text,
      clientNames: names,
      send: { [weak self] in self?.send(text) },
      cancel: { [weak self] in self?.extensionContext?.cancelRequest(withError: CocoaError(.userCancelled)) }
    ))
    addChild(host)
    host.view.frame = view.bounds
    host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
    view.addSubview(host.view)
    host.didMove(toParent: self)
  }

  private func send(_ text: String) {
    Task { @MainActor in
      do {
        try ShareInbox.shared().enqueue(mimeType: sharedMimeType, text: text)
        let content = UNMutableNotificationContent()
        content.title = "Shared to Vibestudio"
        content.body = "Open Vibestudio to deliver it."
        try await UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
        extensionContext?.completeRequest(returningItems: nil)
      } catch {
        extensionContext?.cancelRequest(withError: error)
      }
    }
  }
}

struct ShareView: View {
  let text: String
  let clientNames: [String]
  let send: () -> Void
  let cancel: () -> Void

  var body: some View {
    NavigationStack {
      VStack(alignment: .leading, spacing: 12) {
        Text(text).lineLimit(6)
        if clientNames.isEmpty {
          Text("No Vibestudio client accepts this item.").foregroundStyle(.secondary)
        } else {
          Text("Sends to \(clientNames.joined(separator: ", ")).").foregroundStyle(.secondary)
        }
        Spacer()
      }
      .padding()
      .navigationTitle("Vibestudio")
      .navigationBarTitleDisplayMode(.inline)
      .toolbar {
        ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: cancel) }
        ToolbarItem(placement: .confirmationAction) { Button("Send", action: send).disabled(clientNames.isEmpty) }
      }
    }
  }
}

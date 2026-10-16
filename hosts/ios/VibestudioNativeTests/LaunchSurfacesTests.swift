import Foundation
import XCTest
@testable import Vibestudio

private func item(_ intent: String, _ label: String, _ link: String) -> LaunchItem {
  LaunchItem(intent: intent, label: label, link: link)
}

private func client(_ id: String, _ title: String, shortcuts: [LaunchItem], recent: [LaunchItem] = []) -> LaunchClient {
  LaunchClient(clientId: id, title: title, shortcuts: shortcuts, recent: recent)
}

private let sample = LaunchSurfaces(
  clients: [
    client("chat", "Chat", shortcuts: [item("open", "Chat", "vibestudio://c/chat/open"), item("new", "New chat", "vibestudio://c/chat/new")]),
    client("notes", "Notes", shortcuts: [item("open", "Notes", "vibestudio://c/notes/open")]),
  ],
  background: [
    BackgroundEntry(clientId: "chat", clientTitle: "Chat", intent: "ask", title: "Ask", textParam: "prompt"),
  ],
  shareIn: [
    ShareInEntry(clientId: "chat", clientTitle: "Chat", intent: "share-in", textParam: "text", accepts: ["text/*", "image/*"]),
    ShareInEntry(clientId: "pdf", clientTitle: "PDFs", intent: "share-in", textParam: "text", accepts: ["application/pdf"]),
  ]
)

final class LaunchSurfacesTests: XCTestCase {
  func testSnapshotDecodesTheHostRuntimeJSON() throws {
    let json = """
    {"clients":[{"clientId":"chat","title":"Chat","shortcuts":[{"intent":"open","label":"Chat","link":"vibestudio://c/chat/open"}],"recent":[]}],
     "background":[{"clientId":"chat","clientTitle":"Chat","intent":"ask","title":"Ask","textParam":"prompt"}],
     "shareIn":[{"clientId":"chat","clientTitle":"Chat","intent":"share-in","textParam":"text","accepts":["text/*"]}]}
    """
    let surfaces = try JSONDecoder().decode(LaunchSurfaces.self, from: Data(json.utf8))
    XCTAssertEqual(surfaces.clients.map(\.clientId), ["chat"])
    XCTAssertEqual(surfaces.openLink(clientId: "chat"), "vibestudio://c/chat/open")
    XCTAssertEqual(surfaces.askEntry(clientId: nil)?.intent, "ask")
    XCTAssertNil(surfaces.askEntry(clientId: "notes"))
  }

  func testQuickActionsGiveEachClientItsOpenBeforeAnySecondShortcut() {
    XCTAssertEqual(sample.quickActions().map(\.title), ["Chat", "Notes", "Chat: New chat"])
  }

  func testQuickActionsRespectTheLimit() {
    XCTAssertEqual(sample.quickActions(limit: 2).map(\.link), ["vibestudio://c/chat/open", "vibestudio://c/notes/open"])
    XCTAssertEqual(sample.quickActions(limit: 0), [])
    XCTAssertEqual(LaunchSurfaces.empty.quickActions(), [])
  }

  func testShareTargetsMatchByMimePattern() {
    XCTAssertEqual(sample.shareTargets(mimeType: "text/plain").map(\.clientId), ["chat"])
    XCTAssertEqual(sample.shareTargets(mimeType: "IMAGE/png").map(\.clientId), ["chat"])
    XCTAssertEqual(sample.shareTargets(mimeType: "application/pdf").map(\.clientId), ["pdf"])
    XCTAssertEqual(sample.shareTargets(mimeType: "application/zip"), [])
    XCTAssertTrue(LaunchSurfaces.accepts(["*/*"], mimeType: "application/zip"))
  }
}

final class ShareInboxTests: XCTestCase {
  private var directory: URL!

  override func setUpWithError() throws {
    directory = FileManager.default.temporaryDirectory.appendingPathComponent("share-inbox-\(UUID().uuidString)")
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: directory)
  }

  func testDrainEmitsOldestFirstAndDeletesAfterEmit() throws {
    let inbox = ShareInbox(directory: directory)
    try inbox.enqueue(mimeType: "text/plain", text: "second", now: Date(timeIntervalSince1970: 20))
    try inbox.enqueue(mimeType: "text/plain", text: "first", now: Date(timeIntervalSince1970: 10))
    var seen: [String] = []
    try inbox.drain { seen.append($0.text) }
    XCTAssertEqual(seen, ["first", "second"])
    var again: [String] = []
    try inbox.drain { again.append($0.text) }
    XCTAssertEqual(again, [])
  }

  func testAFailedEmitKeepsThatItemAndTheRest() throws {
    let inbox = ShareInbox(directory: directory)
    try inbox.enqueue(mimeType: "text/plain", text: "a", now: Date(timeIntervalSince1970: 1))
    try inbox.enqueue(mimeType: "text/plain", text: "b", now: Date(timeIntervalSince1970: 2))
    struct Refused: Error {}
    XCTAssertThrowsError(try inbox.drain { _ in throw Refused() })
    var seen: [String] = []
    try inbox.drain { seen.append($0.text) }
    XCTAssertEqual(seen, ["a", "b"])
  }

  func testEqualTimestampsOrderByID() {
    let a = ShareInboxItem(id: "a", createdAt: 5, mimeType: "text/plain", text: "a")
    let b = ShareInboxItem(id: "b", createdAt: 5, mimeType: "text/plain", text: "b")
    XCTAssertEqual(ShareInbox.ordered([("x", b), ("y", a)]).map(\.1.id), ["a", "b"])
  }

  func testDrainDropsAnUndecodableFile() throws {
    let inbox = ShareInbox(directory: directory)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    let bad = directory.appendingPathComponent("bad.json")
    try Data("not json".utf8).write(to: bad)
    try inbox.drain { _ in XCTFail("nothing decodable") }
    XCTAssertFalse(FileManager.default.fileExists(atPath: bad.path))
  }
}

import Foundation
import XCTest
@testable import Vibestudio

final class IrohLifecycleTests: XCTestCase {
  private func result(_ invoke: (@escaping (Any?) -> Void, @escaping (String?, String?, Error?) -> Void) -> Void) async throws -> Any? {
    try await withCheckedThrowingContinuation { continuation in
      invoke({ continuation.resume(returning: $0) }, { _, message, error in
        continuation.resume(throwing: error ?? NSError(domain: "IrohLifecycleTests", code: 1,
          userInfo: [NSLocalizedDescriptionKey: message ?? "Native operation failed"]))
      })
    }
  }

  private func withIdentity(_ body: (String) async throws -> Void) async throws {
    let keys = VibestudioIroh()
    defer { keys.invalidate() }
    let value = try await result { keys.createIdentity($0, rejecter: $1) }
    let identity = try XCTUnwrap((value as? [String: String])?["identityId"])
    do {
      try await body(identity)
    } catch {
      _ = try? await result { keys.deleteIdentity(identity, resolver: $0, rejecter: $1) }
      throw error
    }
    _ = try await result { keys.deleteIdentity(identity, resolver: $0, rejecter: $1) }
  }

  private func bind(_ module: VibestudioIroh, identity: String) async throws -> String {
    let value = try await result { module.bind(identity, relays: [],
      alpnBase64: Data("vibestudio-native-lifecycle-test".utf8).base64EncodedString(),
      resolver: $0, rejecter: $1) }
    return try XCTUnwrap((value as? [String: String])?["endpointHandle"])
  }

  func testInvalidationReleasesPendingNativeAcceptAndPreservesIdentity() async throws {
    try await withIdentity { identity in
      var module: VibestudioIroh? = VibestudioIroh()
      defer { module?.invalidate() }
      let handle = try await bind(module!, identity: identity)
      let completed = expectation(description: "Pending native accept ends on invalidation")
      module!.accept(handle, resolver: { _ in completed.fulfill() }, rejecter: { _, _, _ in completed.fulfill() })
      weak var retired = module
      module!.invalidate()
      module = nil
      await fulfillment(of: [completed], timeout: 5)
      let released = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in retired == nil }, object: nil)
      await fulfillment(of: [released], timeout: 5)

      let replacement = VibestudioIroh()
      defer { replacement.invalidate() }
      let rebound = try await bind(replacement, identity: identity)
      _ = try await result { replacement.shutdownEndpoint(rebound, resolver: $0, rejecter: $1) }
    }
  }

  func testInvalidatedRuntimeRejectsNewBindingsAndIsIdempotent() async throws {
    try await withIdentity { identity in
      let module = VibestudioIroh()
      module.invalidate()
      module.invalidate()
      do {
        _ = try await bind(module, identity: identity)
        XCTFail("An invalidated runtime must not publish a new endpoint")
      } catch {
        XCTAssertTrue(error.localizedDescription.contains("invalidated"))
      }
    }
  }
}

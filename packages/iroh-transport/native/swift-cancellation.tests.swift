import XCTest
@testable import IrohLib

final class CancellationTests: XCTestCase {
    private func assertNativeFailure(_ error: Error, contains message: String, file: StaticString = #filePath, line: UInt = #line) {
        guard let cause = error as? IrohError else {
            return XCTFail("Expected the original Iroh failure, got \(error)", file: file, line: line)
        }
        XCTAssertTrue(cause.message().contains(message), cause.debugMessage(), file: file, line: line)
    }

    private func withEndpoint(_ body: (Endpoint) async throws -> Void) async throws {
        let endpoint = try await Endpoint.bind(options: EndpointOptions(preset: presetMinimal()))
        let outcome: Result<Void, Error>
        do {
            try await body(endpoint)
            outcome = .success(())
        } catch {
            outcome = .failure(error)
        }
        do {
            try await endpoint.close()
        } catch {
            XCTFail("Endpoint retirement failed: \(error)")
            if case .success = outcome { throw error }
        }
        try outcome.get()
    }

    func testClosedEndpointSettlesReadinessWithItsOriginalFailure() async throws {
        try await withEndpoint { endpoint in
            try await endpoint.close()
            do {
                try await endpoint.online()
                XCTFail("A closed endpoint became online")
            } catch {
                assertNativeFailure(error, contains: "Endpoint closed before becoming online")
            }
        }
    }

    func testCancellationBeforeDialIsTerminalAndConsumedOnce() async throws {
        try await withEndpoint { endpoint in
            let attempt = try endpoint.beginConnect(addr: endpoint.addr(), alpn: Data("cancellation-test".utf8))
            await attempt.cancel()
            do {
                let connection = try await attempt.connect()
                try connection.close(errorCode: 0, reason: Data())
                XCTFail("A cancelled dial connected")
            } catch {
                assertNativeFailure(error, contains: "Dial cancelled")
            }
            do {
                let connection = try await attempt.connect()
                try connection.close(errorCode: 0, reason: Data())
                XCTFail("A dial was consumed twice")
            } catch {
                assertNativeFailure(error, contains: "Dial already consumed")
            }
        }
    }

    func testEndpointClosureSettlesItsOwnedDial() async throws {
        try await withEndpoint { endpoint in
            let attempt = try endpoint.beginConnect(addr: endpoint.addr(), alpn: Data("cancellation-test".utf8))
            try await endpoint.close()
            do {
                let connection = try await attempt.connect()
                try connection.close(errorCode: 0, reason: Data())
                XCTFail("A closed endpoint connected")
            } catch {
                assertNativeFailure(error, contains: "Endpoint closed during dial")
            }
            await attempt.cancel()
        }
    }
}

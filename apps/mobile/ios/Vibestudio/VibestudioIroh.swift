import Foundation
import IrohLib
import React
import Security

@objc(VibestudioIroh)
final class VibestudioIroh: NSObject, RCTBridgeModule {
  static func moduleName() -> String! { "VibestudioIroh" }
  static func requiresMainQueueSetup() -> Bool { false }

  private let lock = NSLock()
  private var endpoints: [String: Endpoint] = [:]
  private var endpointIdentities: [String: String] = [:]
  private var connections: [String: Connection] = [:]
  private var sends: [String: SendStream] = [:]
  private var receives: [String: RecvStream] = [:]
  private var sendConnections: [String: String] = [:]
  private var receiveConnections: [String: String] = [:]

  @objc func createIdentity(_ resolve: @escaping RCTPromiseResolveBlock,
                            rejecter reject: @escaping RCTPromiseRejectBlock) {
    perform(resolve, reject) {
      let identityId = UUID().uuidString
      let secret = SecretKey.generate()
      try self.storeSecret(secret.toBytes(), identityId: identityId)
      return ["identityId": identityId, "endpointId": secret.`public`().description]
    }
  }

  @objc func deleteIdentity(_ identityId: String,
                            resolver resolve: @escaping RCTPromiseResolveBlock,
                            rejecter reject: @escaping RCTPromiseRejectBlock) {
    perform(resolve, reject) {
      guard !self.hasBoundEndpoint(identityId: identityId) else {
        throw BridgeError.boundIdentity
      }
      try self.deleteSecret(identityId: identityId)
      return nil
    }
  }

  @objc func bind(_ identityId: String,
                  relays: [String],
                  alpnBase64: String,
                  resolver resolve: @escaping RCTPromiseResolveBlock,
                  rejecter reject: @escaping RCTPromiseRejectBlock) {
    perform(resolve, reject) {
      let secret = try self.loadSecret(identityId: identityId)
      let endpoint = try await Endpoint.bind(options: EndpointOptions(
        preset: nil,
        secretKey: secret,
        alpns: [try self.data(alpnBase64)],
        relayMode: try RelayMode.customFromUrls(urls: relays),
        protocols: nil
      ))
      let handle = self.putEndpoint(endpoint, identityId: identityId)
      return ["endpointHandle": handle, "endpointId": endpoint.id().description]
    }
  }

  @objc func shutdownEndpoint(_ handle: String,
                              resolver resolve: @escaping RCTPromiseResolveBlock,
                              rejecter reject: @escaping RCTPromiseRejectBlock) {
    perform(resolve, reject) {
      if let endpoint = self.removeEndpoint(handle) {
        try await endpoint.close()
      }
      return nil
    }
  }

  @objc func dial(_ handle: String,
                  endpointId: String,
                  relayUrl: String,
                  alpnBase64: String,
                  resolver resolve: @escaping RCTPromiseResolveBlock,
                  rejecter reject: @escaping RCTPromiseRejectBlock) {
    perform(resolve, reject) {
      let endpoint = try self.requireEndpoint(handle)
      let address = EndpointAddr(
        id: try EndpointId.fromString(s: endpointId),
        relayUrl: relayUrl,
        addresses: []
      )
      let connection = try await endpoint.connect(addr: address, alpn: try self.data(alpnBase64))
      return try self.connectionResult(connection)
    }
  }

  @objc func accept(_ handle: String,
                    resolver resolve: @escaping RCTPromiseResolveBlock,
                    rejecter reject: @escaping RCTPromiseRejectBlock) {
    perform(resolve, reject) {
      let endpoint = try self.requireEndpoint(handle)
      guard let incoming = await endpoint.acceptNext() else { return nil }
      let accepting = try await incoming.accept()
      let connection = try await accepting.connect()
      return try self.connectionResult(connection)
    }
  }

  @objc func openBi(_ handle: String,
                    resolver resolve: @escaping RCTPromiseResolveBlock,
                    rejecter reject: @escaping RCTPromiseRejectBlock) {
    perform(resolve, reject) {
      let connection = try self.requireConnection(handle)
      return self.streamResult(try await connection.openBi(), connectionHandle: handle)
    }
  }

  @objc func acceptBi(_ handle: String,
                      resolver resolve: @escaping RCTPromiseResolveBlock,
                      rejecter reject: @escaping RCTPromiseRejectBlock) {
    perform(resolve, reject) {
      let connection = try self.requireConnection(handle)
      return self.streamResult(try await connection.acceptBi(), connectionHandle: handle)
    }
  }

  @objc func write(_ handle: String, bytesBase64: String,
                   resolver resolve: @escaping RCTPromiseResolveBlock,
                   rejecter reject: @escaping RCTPromiseRejectBlock) {
    perform(resolve, reject) {
      let send = try self.requireSend(handle)
      try await send.writeAll(buf: try self.data(bytesBase64)); return nil
    }
  }

  @objc func finish(_ handle: String, resolver resolve: @escaping RCTPromiseResolveBlock,
                    rejecter reject: @escaping RCTPromiseRejectBlock) {
    perform(resolve, reject) {
      let send = try self.requireSend(handle)
      try await send.finish(); self.removeSend(handle); return nil
    }
  }

  @objc func reset(_ handle: String, errorCode: String,
                   resolver resolve: @escaping RCTPromiseResolveBlock,
                   rejecter reject: @escaping RCTPromiseRejectBlock) {
    perform(resolve, reject) {
      let send = try self.requireSend(handle)
      try await send.reset(errorCode: try self.code(errorCode)); self.removeSend(handle); return nil
    }
  }

  @objc func stopped(_ handle: String, resolver resolve: @escaping RCTPromiseResolveBlock,
                     rejecter reject: @escaping RCTPromiseRejectBlock) {
    perform(resolve, reject) {
      let send = try self.requireSend(handle)
      return try await send.stopped().map(String.init)
    }
  }

  @objc func read(_ handle: String, maximumBytes: NSNumber,
                  resolver resolve: @escaping RCTPromiseResolveBlock,
                  rejecter reject: @escaping RCTPromiseRejectBlock) {
    perform(resolve, reject) {
      let size = maximumBytes.intValue
      guard (1...1_048_576).contains(size) else { throw BridgeError.invalidRead }
      let receive = try self.requireReceive(handle)
      let bytes = try await receive.read(sizeLimit: UInt32(size))
      if bytes.isEmpty { self.removeReceive(handle) }
      return bytes.base64EncodedString()
    }
  }

  @objc func readExact(_ handle: String, length: NSNumber,
                       resolver resolve: @escaping RCTPromiseResolveBlock,
                       rejecter reject: @escaping RCTPromiseRejectBlock) {
    perform(resolve, reject) {
      let size = length.intValue
      guard (0...1_048_576).contains(size) else { throw BridgeError.invalidRead }
      let receive = try self.requireReceive(handle)
      return try await receive.readExact(size: UInt32(size)).base64EncodedString()
    }
  }

  @objc func stop(_ handle: String, errorCode: String,
                  resolver resolve: @escaping RCTPromiseResolveBlock,
                  rejecter reject: @escaping RCTPromiseRejectBlock) {
    perform(resolve, reject) {
      let receive = try self.requireReceive(handle)
      try await receive.stop(errorCode: try self.code(errorCode)); self.removeReceive(handle); return nil
    }
  }

  @objc func receivedReset(_ handle: String,
                           resolver resolve: @escaping RCTPromiseResolveBlock,
                           rejecter reject: @escaping RCTPromiseRejectBlock) {
    perform(resolve, reject) {
      let receive = try self.requireReceive(handle)
      let code = try await receive.receivedReset()
      if code != nil { self.removeReceive(handle) }
      return code.map(String.init)
    }
  }

  @objc func closeConnection(_ handle: String, errorCode: String, reasonBase64: String) {
    guard let connection = removeConnection(handle),
          let code = UInt64(errorCode),
          let reason = Data(base64Encoded: reasonBase64) else { return }
    removeStreams(connectionHandle: handle)
    connection.close(errorCode: Int64(code), reason: reason)
  }

  @objc func connectionClosed(_ handle: String,
                              resolver resolve: @escaping RCTPromiseResolveBlock,
                              rejecter reject: @escaping RCTPromiseRejectBlock) {
    perform(resolve, reject) {
      let connection = try self.requireConnection(handle)
      return await connection.closed()
    }
  }

  private func connectionResult(_ connection: Connection) throws -> [String: String] {
    // QUIC replenishes MAX_STREAMS as streams close; this is a finite
    // simultaneous-flow-control window, not a product request limit. Keep the
    // native clients aligned with the Node transport.
    try connection.setMaxConcurrentBiStreams(count: 32_768)
    try connection.setMaxConcurrentUniStreams(count: 0)
    let handle = putConnection(connection)
    return ["connectionHandle": handle, "peerEndpointId": connection.remoteId().description]
  }

  private func streamResult(_ stream: BiStream, connectionHandle: String) -> [String: String] {
    let sendHandle = UUID().uuidString
    let receiveHandle = UUID().uuidString
    lock.lock()
    sends[sendHandle] = stream.send()
    receives[receiveHandle] = stream.recv()
    sendConnections[sendHandle] = connectionHandle
    receiveConnections[receiveHandle] = connectionHandle
    lock.unlock()
    return ["sendHandle": sendHandle, "receiveHandle": receiveHandle]
  }

  private func perform(_ resolve: @escaping RCTPromiseResolveBlock,
                       _ reject: @escaping RCTPromiseRejectBlock,
                       operation: @escaping () async throws -> Any?) {
    Task {
      do { resolve(try await operation()) }
      catch { reject("IROH_NATIVE", error.localizedDescription, error) }
    }
  }

  private func putEndpoint(_ value: Endpoint, identityId: String) -> String {
    lock.lock(); defer { lock.unlock() }
    let handle = UUID().uuidString
    endpoints[handle] = value; endpointIdentities[handle] = identityId; return handle
  }
  private func putConnection(_ value: Connection) -> String {
    lock.lock(); defer { lock.unlock() }
    let handle = UUID().uuidString; connections[handle] = value; return handle
  }
  private func removeEndpoint(_ handle: String) -> Endpoint? {
    lock.lock(); defer { lock.unlock() }
    endpointIdentities.removeValue(forKey: handle); return endpoints.removeValue(forKey: handle)
  }
  private func hasBoundEndpoint(identityId: String) -> Bool {
    lock.lock(); defer { lock.unlock() }; return endpointIdentities.values.contains(identityId)
  }
  private func removeConnection(_ handle: String) -> Connection? {
    lock.lock(); defer { lock.unlock() }; return connections.removeValue(forKey: handle)
  }
  private func removeSend(_ handle: String) {
    lock.lock(); defer { lock.unlock() }
    sends.removeValue(forKey: handle); sendConnections.removeValue(forKey: handle)
  }
  private func removeReceive(_ handle: String) {
    lock.lock(); defer { lock.unlock() }
    receives.removeValue(forKey: handle); receiveConnections.removeValue(forKey: handle)
  }
  private func removeStreams(connectionHandle: String) {
    lock.lock(); defer { lock.unlock() }
    for handle in sendConnections.filter({ $0.value == connectionHandle }).keys {
      sends.removeValue(forKey: handle); sendConnections.removeValue(forKey: handle)
    }
    for handle in receiveConnections.filter({ $0.value == connectionHandle }).keys {
      receives.removeValue(forKey: handle); receiveConnections.removeValue(forKey: handle)
    }
  }
  private func requireEndpoint(_ handle: String) throws -> Endpoint {
    lock.lock(); defer { lock.unlock() }
    guard let value = endpoints[handle] else { throw BridgeError.unknownHandle("endpoint") }; return value
  }
  private func requireConnection(_ handle: String) throws -> Connection {
    lock.lock(); defer { lock.unlock() }
    guard let value = connections[handle] else { throw BridgeError.unknownHandle("connection") }; return value
  }
  private func requireSend(_ handle: String) throws -> SendStream {
    lock.lock(); defer { lock.unlock() }
    guard let value = sends[handle] else { throw BridgeError.unknownHandle("send stream") }; return value
  }
  private func requireReceive(_ handle: String) throws -> RecvStream {
    lock.lock(); defer { lock.unlock() }
    guard let value = receives[handle] else { throw BridgeError.unknownHandle("receive stream") }; return value
  }

  private func data(_ base64: String) throws -> Data {
    guard let value = Data(base64Encoded: base64) else { throw BridgeError.invalidBase64 }
    return value
  }

  private func code(_ value: String) throws -> UInt64 {
    guard let result = UInt64(value) else { throw BridgeError.invalidCode }; return result
  }

  private func storeSecret(_ secret: Data, identityId: String) throws {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "vibestudio:iroh:endpoint-identity",
      kSecAttrAccount as String: identityId,
      kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
      kSecValueData as String: secret,
    ]
    let status = SecItemAdd(query as CFDictionary, nil)
    guard status == errSecSuccess else { throw BridgeError.keychain(status) }
  }

  private func loadSecret(identityId: String) throws -> Data {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "vibestudio:iroh:endpoint-identity",
      kSecAttrAccount as String: identityId,
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var result: CFTypeRef?
    let status = SecItemCopyMatching(query as CFDictionary, &result)
    guard status == errSecSuccess, let secret = result as? Data else { throw BridgeError.keychain(status) }
    return secret
  }

  private func deleteSecret(identityId: String) throws {
    let status = SecItemDelete([
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "vibestudio:iroh:endpoint-identity",
      kSecAttrAccount as String: identityId,
    ] as CFDictionary)
    guard status == errSecSuccess || status == errSecItemNotFound else { throw BridgeError.keychain(status) }
  }

  private enum BridgeError: LocalizedError {
    case unknownHandle(String), invalidBase64, invalidCode, invalidRead, boundIdentity, keychain(OSStatus)
    var errorDescription: String? {
      switch self {
      case .unknownHandle(let kind): return "Unknown Iroh \(kind) handle"
      case .invalidBase64: return "Invalid base64 bridge payload"
      case .invalidCode: return "Invalid Iroh application error code"
      case .invalidRead: return "Invalid bounded stream read size"
      case .boundIdentity: return "Cannot delete an identity while its endpoint is bound"
      case .keychain(let status): return "Iroh Keychain operation failed (\(status))"
      }
    }
  }
}

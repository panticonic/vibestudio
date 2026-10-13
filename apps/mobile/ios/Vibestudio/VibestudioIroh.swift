import Foundation
import IrohLib
import React
import Security

private final class NativeStreamEntry<Stream> {
  let stream: Stream
  let connectionHandle: String
  var activeOperations = 0
  var retiring = false
  var terminalClaimed = false

  init(stream: Stream, connectionHandle: String) {
    self.stream = stream
    self.connectionHandle = connectionHandle
  }
}

@objc(VibestudioIroh)
final class VibestudioIroh: NSObject, RCTBridgeModule, RCTInvalidating {
  static func moduleName() -> String! { "VibestudioIroh" }
  static func requiresMainQueueSetup() -> Bool { false }

  private let lock = NSLock()
  private var active = true
  private var endpoints: [String: Endpoint] = [:]
  private var endpointIdentities: [String: String] = [:]
  private var connections: [String: Connection] = [:]
  private var sends: [String: NativeStreamEntry<SendStream>] = [:]
  private var receives: [String: NativeStreamEntry<RecvStream>] = [:]

  @objc func invalidate() {
    lock.lock()
    guard active else { lock.unlock(); return }
    active = false
    let ownedEndpoints = Array(endpoints.values)
    let ownedConnections = Array(connections.values)
    endpoints.removeAll()
    endpointIdentities.removeAll()
    connections.removeAll()
    sends.values.forEach { $0.retiring = true }
    receives.values.forEach { $0.retiring = true }
    lock.unlock()

    for connection in ownedConnections {
      do { try connection.close(errorCode: 0, reason: Data()) }
      catch { NSLog("[VibestudioIroh] Runtime connection retirement failed: %@", error.localizedDescription) }
    }
    // In-flight operations retain their entries and release them on completion.
    // Remove idle entries now; active entries are removed by their final lease.
    lock.lock()
    sends = sends.filter { $0.value.activeOperations > 0 }
    receives = receives.filter { $0.value.activeOperations > 0 }
    lock.unlock()
    // React Native's invalidation hook is synchronous. Close the detached
    // endpoints without retaining this module, waking its pending native reads.
    Task {
      for endpoint in ownedEndpoints {
        do { try await endpoint.close() }
        catch { NSLog("[VibestudioIroh] Runtime endpoint retirement failed: %@", error.localizedDescription) }
      }
    }
  }

  private var isActive: Bool {
    lock.lock(); defer { lock.unlock() }; return active
  }

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
      guard let handle = self.putEndpoint(endpoint, identityId: identityId) else {
        try await endpoint.close()
        throw BridgeError.runtimeInvalidated
      }
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
      return try await self.streamResult(try await connection.openBi(), connectionHandle: handle)
    }
  }

  @objc func acceptBi(_ handle: String,
                      resolver resolve: @escaping RCTPromiseResolveBlock,
                      rejecter reject: @escaping RCTPromiseRejectBlock) {
    perform(resolve, reject) {
      let connection = try self.requireConnection(handle)
      return try await self.streamResult(try await connection.acceptBi(), connectionHandle: handle)
    }
  }

  @objc func write(_ handle: String, bytesBase64: String,
                   resolver resolve: @escaping RCTPromiseResolveBlock,
                   rejecter reject: @escaping RCTPromiseRejectBlock) {
    perform(resolve, reject) {
      let entry = try self.acquireSend(handle)
      defer { self.releaseSend(handle, entry) }
      try await entry.stream.writeAll(buf: try self.data(bytesBase64)); return nil
    }
  }

  @objc func finish(_ handle: String, resolver resolve: @escaping RCTPromiseResolveBlock,
                    rejecter reject: @escaping RCTPromiseRejectBlock) {
    perform(resolve, reject) {
      guard let entry = try self.claimSendTerminal(handle) else { return nil }
      defer { self.releaseSend(handle, entry) }
      try await entry.stream.finish(); return nil
    }
  }

  @objc func reset(_ handle: String, errorCode: String,
                   resolver resolve: @escaping RCTPromiseResolveBlock,
                   rejecter reject: @escaping RCTPromiseRejectBlock) {
    perform(resolve, reject) {
      guard let entry = try self.claimSendTerminal(handle) else { return nil }
      defer { self.releaseSend(handle, entry) }
      try await entry.stream.reset(errorCode: try self.code(errorCode)); return nil
    }
  }

  @objc func stopped(_ handle: String, resolver resolve: @escaping RCTPromiseResolveBlock,
                     rejecter reject: @escaping RCTPromiseRejectBlock) {
    perform(resolve, reject) {
      let entry = try self.acquireSend(handle)
      defer { self.releaseSend(handle, entry) }
      return try await entry.stream.stopped().map(String.init)
    }
  }

  @objc func read(_ handle: String, maximumBytes: NSNumber,
                  resolver resolve: @escaping RCTPromiseResolveBlock,
                  rejecter reject: @escaping RCTPromiseRejectBlock) {
    perform(resolve, reject) {
      let size = maximumBytes.intValue
      guard (1...1_048_576).contains(size) else { throw BridgeError.invalidRead }
      let entry = try self.acquireReceive(handle)
      defer { self.releaseReceive(handle, entry) }
      let bytes = try await entry.stream.read(sizeLimit: UInt32(size))
      if bytes.isEmpty { self.retireReceive(handle, entry) }
      return bytes.base64EncodedString()
    }
  }

  @objc func readExact(_ handle: String, length: NSNumber,
                       resolver resolve: @escaping RCTPromiseResolveBlock,
                       rejecter reject: @escaping RCTPromiseRejectBlock) {
    perform(resolve, reject) {
      let size = length.intValue
      guard (0...1_048_576).contains(size) else { throw BridgeError.invalidRead }
      let entry = try self.acquireReceive(handle)
      defer { self.releaseReceive(handle, entry) }
      return try await entry.stream.readExact(size: UInt32(size)).base64EncodedString()
    }
  }

  @objc func stop(_ handle: String, errorCode: String,
                  resolver resolve: @escaping RCTPromiseResolveBlock,
                  rejecter reject: @escaping RCTPromiseRejectBlock) {
    perform(resolve, reject) {
      guard let entry = try self.claimReceiveTerminal(handle) else { return nil }
      defer { self.releaseReceive(handle, entry) }
      try await entry.stream.stop(errorCode: try self.code(errorCode)); return nil
    }
  }

  @objc func receivedReset(_ handle: String,
                           resolver resolve: @escaping RCTPromiseResolveBlock,
                           rejecter reject: @escaping RCTPromiseRejectBlock) {
    perform(resolve, reject) {
      let entry = try self.acquireReceive(handle)
      defer { self.releaseReceive(handle, entry) }
      let code = try await entry.stream.receivedReset()
      if code != nil { self.retireReceive(handle, entry) }
      return code.map(String.init)
    }
  }

  @objc func closeConnection(_ handle: String, errorCode: String, reasonBase64: String) {
    guard let code = Int64(errorCode), let reason = Data(base64Encoded: reasonBase64) else { return }
    let connection = retireConnection(handle)
    guard let connection else { return }
    do {
      try connection.close(errorCode: code, reason: reason)
    } catch {
      RCTFatal(error as NSError)
    }
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
    guard let handle = putConnection(connection) else {
      try connection.close(errorCode: 0, reason: Data())
      throw BridgeError.runtimeInvalidated
    }
    return ["connectionHandle": handle, "peerEndpointId": connection.remoteId().description]
  }

  private func streamResult(_ stream: BiStream, connectionHandle: String) async throws -> [String: String] {
    if let result = putStreams(stream, connectionHandle: connectionHandle) { return result }
    try await stream.send().reset(errorCode: 0)
    try await stream.recv().stop(errorCode: 0)
    throw BridgeError.runtimeInvalidated
  }

  private func putStreams(_ stream: BiStream, connectionHandle: String) -> [String: String]? {
    lock.lock(); defer { lock.unlock() }
    guard active && connections[connectionHandle] != nil else { return nil }
    let sendHandle = UUID().uuidString
    let receiveHandle = UUID().uuidString
    sends[sendHandle] = NativeStreamEntry(stream: stream.send(), connectionHandle: connectionHandle)
    receives[receiveHandle] = NativeStreamEntry(stream: stream.recv(), connectionHandle: connectionHandle)
    return ["sendHandle": sendHandle, "receiveHandle": receiveHandle]
  }

  private func perform(_ resolve: @escaping RCTPromiseResolveBlock,
                       _ reject: @escaping RCTPromiseRejectBlock,
                       operation: @escaping () async throws -> Any?) {
    Task {
      do {
        guard self.isActive else { throw BridgeError.runtimeInvalidated }
        let result = try await operation()
        guard self.isActive else { throw BridgeError.runtimeInvalidated }
        resolve(result)
      }
      catch { reject("IROH_NATIVE", error.localizedDescription, error) }
    }
  }

  private func putEndpoint(_ value: Endpoint, identityId: String) -> String? {
    lock.lock(); defer { lock.unlock() }
    guard active else { return nil }
    let handle = UUID().uuidString
    endpoints[handle] = value; endpointIdentities[handle] = identityId; return handle
  }
  private func putConnection(_ value: Connection) -> String? {
    lock.lock(); defer { lock.unlock() }
    guard active else { return nil }
    let handle = UUID().uuidString; connections[handle] = value; return handle
  }
  private func removeEndpoint(_ handle: String) -> Endpoint? {
    lock.lock(); defer { lock.unlock() }
    endpointIdentities.removeValue(forKey: handle); return endpoints.removeValue(forKey: handle)
  }
  private func hasBoundEndpoint(identityId: String) -> Bool {
    lock.lock(); defer { lock.unlock() }; return endpointIdentities.values.contains(identityId)
  }
  private func retireConnection(_ handle: String) -> Connection? {
    lock.lock(); defer { lock.unlock() }
    guard let connection = connections.removeValue(forKey: handle) else { return nil }
    retireStreamsLocked(connectionHandle: handle)
    return connection
  }
  private func acquireSend(_ handle: String) throws -> NativeStreamEntry<SendStream> {
    lock.lock(); defer { lock.unlock() }
    guard let entry = sends[handle] else { throw BridgeError.closedStream("send") }
    guard active && !entry.retiring else { throw BridgeError.closedStream("send") }
    entry.activeOperations += 1
    return entry
  }
  private func acquireReceive(_ handle: String) throws -> NativeStreamEntry<RecvStream> {
    lock.lock(); defer { lock.unlock() }
    guard let entry = receives[handle] else { throw BridgeError.closedStream("receive") }
    guard active && !entry.retiring else { throw BridgeError.closedStream("receive") }
    entry.activeOperations += 1
    return entry
  }
  private func claimSendTerminal(_ handle: String) throws -> NativeStreamEntry<SendStream>? {
    lock.lock(); defer { lock.unlock() }
    guard active else { throw BridgeError.runtimeInvalidated }
    guard let entry = sends[handle] else { throw BridgeError.closedStream("send") }
    if entry.terminalClaimed { return nil }
    guard !entry.retiring else { throw BridgeError.closedStream("send") }
    entry.retiring = true; entry.terminalClaimed = true; entry.activeOperations += 1
    return entry
  }
  private func claimReceiveTerminal(_ handle: String) throws -> NativeStreamEntry<RecvStream>? {
    lock.lock(); defer { lock.unlock() }
    guard active else { throw BridgeError.runtimeInvalidated }
    guard let entry = receives[handle] else { throw BridgeError.closedStream("receive") }
    if entry.terminalClaimed { return nil }
    guard !entry.retiring else { throw BridgeError.closedStream("receive") }
    entry.retiring = true; entry.terminalClaimed = true; entry.activeOperations += 1
    return entry
  }
  private func retireReceive(_ handle: String, _ entry: NativeStreamEntry<RecvStream>) {
    lock.lock(); defer { lock.unlock() }
    entry.retiring = true
    if entry.activeOperations == 0 { receives.removeValue(forKey: handle) }
  }
  private func releaseSend(_ handle: String, _ entry: NativeStreamEntry<SendStream>) {
    lock.lock(); defer { lock.unlock() }
    entry.activeOperations -= 1
    precondition(entry.activeOperations >= 0, "Iroh send stream operation lease underflow")
    if entry.retiring && entry.activeOperations == 0 { sends.removeValue(forKey: handle) }
  }
  private func releaseReceive(_ handle: String, _ entry: NativeStreamEntry<RecvStream>) {
    lock.lock(); defer { lock.unlock() }
    entry.activeOperations -= 1
    precondition(entry.activeOperations >= 0, "Iroh receive stream operation lease underflow")
    if entry.retiring && entry.activeOperations == 0 { receives.removeValue(forKey: handle) }
  }
  private func retireStreamsLocked(connectionHandle: String) {
    for (handle, entry) in Array(sends) where entry.connectionHandle == connectionHandle {
      entry.retiring = true
      if entry.activeOperations == 0 { sends.removeValue(forKey: handle) }
    }
    for (handle, entry) in Array(receives) where entry.connectionHandle == connectionHandle {
      entry.retiring = true
      if entry.activeOperations == 0 { receives.removeValue(forKey: handle) }
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
    case unknownHandle(String), closedStream(String), invalidBase64, invalidCode, invalidRead, boundIdentity, runtimeInvalidated, keychain(OSStatus)
    var errorDescription: String? {
      switch self {
      case .unknownHandle(let kind): return "Unknown Iroh \(kind) handle"
      case .closedStream(let kind): return "Iroh \(kind) stream is closed"
      case .invalidBase64: return "Invalid base64 bridge payload"
      case .invalidCode: return "Invalid Iroh application error code"
      case .invalidRead: return "Invalid bounded stream read size"
      case .boundIdentity: return "Cannot delete an identity while its endpoint is bound"
      case .runtimeInvalidated: return "Iroh runtime has been invalidated"
      case .keychain(let status): return "Iroh Keychain operation failed (\(status))"
      }
    }
  }
}

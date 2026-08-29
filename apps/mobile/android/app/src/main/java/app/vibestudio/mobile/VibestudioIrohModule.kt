package app.vibestudio.mobile

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import computer.iroh.*
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import java.security.KeyStore
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey as JceSecretKey
import javax.crypto.spec.GCMParameterSpec

class VibestudioIrohModule(context: ReactApplicationContext) :
    ReactContextBaseJavaModule(context) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val endpoints = ConcurrentHashMap<String, Endpoint>()
    private val endpointIdentities = ConcurrentHashMap<String, String>()
    private val connections = ConcurrentHashMap<String, Connection>()
    private val sends = ConcurrentHashMap<String, SendStream>()
    private val receives = ConcurrentHashMap<String, RecvStream>()
    private val sendConnections = ConcurrentHashMap<String, String>()
    private val receiveConnections = ConcurrentHashMap<String, String>()
    private val preferences = context.getSharedPreferences("vibestudio-iroh-identities", Context.MODE_PRIVATE)

    override fun getName() = "VibestudioIroh"

    @ReactMethod
    fun createIdentity(promise: Promise) = launch(promise) {
        val identityId = UUID.randomUUID().toString()
        val secret = SecretKey.generate()
        preferences.edit().putString(identityId, encrypt(secret.toBytes())).commit().also {
            if (!it) throw IllegalStateException("Encrypted identity storage refused the update")
        }
        Arguments.createMap().apply {
            putString("identityId", identityId)
            putString("endpointId", secret.`public`().toString())
        }
    }

    @ReactMethod
    fun deleteIdentity(identityId: String, promise: Promise) = launch(promise) {
        if (endpointIdentities.containsValue(identityId)) {
            throw IllegalStateException("Cannot delete an identity while its endpoint is bound")
        }
        if (!preferences.edit().remove(identityId).commit()) {
            throw IllegalStateException("Encrypted identity storage refused the deletion")
        }
        null
    }

    @ReactMethod
    fun bind(identityId: String, relays: ReadableArray, alpnBase64: String, promise: Promise) =
        launch(promise) {
            val secretBytes = decrypt(preferences.getString(identityId, null)
                ?: throw IllegalStateException("Iroh endpoint identity is missing"))
            val relayUrls = (0 until relays.size()).map { relays.getString(it)
                ?: throw IllegalArgumentException("Relay URL must be a string") }
            val endpoint = Endpoint.bind(EndpointOptions(
                preset = null,
                secretKey = secretBytes,
                alpns = listOf(Base64.decode(alpnBase64, Base64.NO_WRAP)),
                relayMode = RelayMode.customFromUrls(relayUrls),
                protocols = null,
            ))
            val handle = UUID.randomUUID().toString()
            endpoints[handle] = endpoint
            endpointIdentities[handle] = identityId
            Arguments.createMap().apply {
                putString("endpointHandle", handle)
                putString("endpointId", endpoint.id().toString())
            }
        }

    @ReactMethod
    fun shutdownEndpoint(handle: String, promise: Promise) = launch(promise) {
        endpointIdentities.remove(handle)
        endpoints.remove(handle)?.let { endpoint ->
            endpoint.shutdown()
            endpoint.close()
        }
        null
    }

    @ReactMethod
    fun dial(handle: String, endpointId: String, relayUrl: String, alpnBase64: String, promise: Promise) =
        launch(promise) {
            val endpoint = requireEndpoint(handle)
            val address = EndpointAddr(EndpointId.fromString(endpointId), relayUrl, emptyList())
            connectionResult(endpoint.connect(address, Base64.decode(alpnBase64, Base64.NO_WRAP)))
        }

    @ReactMethod
    fun accept(handle: String, promise: Promise) = launch(promise) {
        val incoming = requireEndpoint(handle).acceptNext() ?: return@launch null
        connectionResult(incoming.accept().connect())
    }

    @ReactMethod fun openBi(handle: String, promise: Promise) = launch(promise) {
        streamResult(requireConnection(handle).openBi(), handle)
    }
    @ReactMethod fun acceptBi(handle: String, promise: Promise) = launch(promise) {
        streamResult(requireConnection(handle).acceptBi(), handle)
    }
    @ReactMethod fun write(handle: String, value: String, promise: Promise) = launch(promise) {
        requireSend(handle).writeAll(Base64.decode(value, Base64.NO_WRAP)); null
    }
    @ReactMethod fun finish(handle: String, promise: Promise) = launch(promise) {
        requireSend(handle).finish(); removeSend(handle); null
    }
    @ReactMethod fun reset(handle: String, code: String, promise: Promise) = launch(promise) {
        requireSend(handle).reset(code.toULong()); removeSend(handle); null
    }
    @ReactMethod fun stopped(handle: String, promise: Promise) = launch(promise) {
        requireSend(handle).stopped()?.toString()
    }
    @ReactMethod fun read(handle: String, maximum: Int, promise: Promise) = launch(promise) {
        if (maximum !in 1..1_048_576) throw IllegalArgumentException("Invalid bounded read size")
        val bytes = requireReceive(handle).read(maximum.toUInt())
        if (bytes.isEmpty()) removeReceive(handle)
        Base64.encodeToString(bytes, Base64.NO_WRAP)
    }
    @ReactMethod fun readExact(handle: String, length: Int, promise: Promise) = launch(promise) {
        if (length !in 0..1_048_576) throw IllegalArgumentException("Invalid exact read size")
        Base64.encodeToString(requireReceive(handle).readExact(length.toUInt()), Base64.NO_WRAP)
    }
    @ReactMethod fun stop(handle: String, code: String, promise: Promise) = launch(promise) {
        requireReceive(handle).stop(code.toULong()); removeReceive(handle); null
    }
    @ReactMethod fun receivedReset(handle: String, promise: Promise) = launch(promise) {
        requireReceive(handle).receivedReset()?.also { removeReceive(handle) }?.toString()
    }

    @ReactMethod
    fun closeConnection(handle: String, code: String, reason: String) {
        connections.remove(handle)?.let { connection ->
            removeStreams(handle)
            connection.close(code.toLong(), Base64.decode(reason, Base64.NO_WRAP))
        }
    }

    @ReactMethod fun connectionClosed(handle: String, promise: Promise) = launch(promise) {
        requireConnection(handle).closed()
    }

    private fun connectionResult(connection: Connection) = Arguments.createMap().apply {
        // QUIC replenishes MAX_STREAMS as streams close; this is a finite
        // simultaneous-flow-control window, not a product request limit. Keep
        // Android aligned with the Node and iOS endpoints so approval, panel,
        // RPC, and asset streams cannot serialize behind an arbitrary mobile cap.
        connection.setMaxConcurrentBiStreams(32_768u)
        connection.setMaxConcurrentUniStreams(0u)
        val handle = UUID.randomUUID().toString()
        connections[handle] = connection
        putString("connectionHandle", handle)
        putString("peerEndpointId", connection.remoteId().toString())
    }

    private fun streamResult(stream: BiStream, connectionHandle: String) = Arguments.createMap().apply {
        val sendHandle = UUID.randomUUID().toString()
        val receiveHandle = UUID.randomUUID().toString()
        sends[sendHandle] = stream.send()
        receives[receiveHandle] = stream.recv()
        sendConnections[sendHandle] = connectionHandle
        receiveConnections[receiveHandle] = connectionHandle
        putString("sendHandle", sendHandle)
        putString("receiveHandle", receiveHandle)
    }

    private fun requireEndpoint(handle: String) = endpoints[handle]
        ?: throw IllegalStateException("Unknown Iroh endpoint handle")
    private fun requireConnection(handle: String) = connections[handle]
        ?: throw IllegalStateException("Unknown Iroh connection handle")
    private fun requireSend(handle: String) = sends[handle]
        ?: throw IllegalStateException("Unknown Iroh send-stream handle")
    private fun requireReceive(handle: String) = receives[handle]
        ?: throw IllegalStateException("Unknown Iroh receive-stream handle")
    private fun removeSend(handle: String) {
        sends.remove(handle)
        sendConnections.remove(handle)
    }
    private fun removeReceive(handle: String) {
        receives.remove(handle)
        receiveConnections.remove(handle)
    }
    private fun removeStreams(connectionHandle: String) {
        sendConnections.entries.removeIf { (handle, owner) ->
            if (owner == connectionHandle) sends.remove(handle)
            owner == connectionHandle
        }
        receiveConnections.entries.removeIf { (handle, owner) ->
            if (owner == connectionHandle) receives.remove(handle)
            owner == connectionHandle
        }
    }

    private fun launch(promise: Promise, block: suspend () -> Any?) {
        scope.launch {
            try { promise.resolve(block()) }
            catch (error: Throwable) { promise.reject("IROH_NATIVE", error.message, error) }
        }
    }

    private fun key(): JceSecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(KEY_ALIAS, null) as? JceSecretKey)?.let { return it }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        generator.init(KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
        ).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setUserAuthenticationRequired(false)
            .build())
        return generator.generateKey()
    }

    private fun encrypt(clear: ByteArray): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        return Base64.encodeToString(cipher.iv + cipher.doFinal(clear), Base64.NO_WRAP)
    }

    private fun decrypt(encoded: String): ByteArray {
        val value = Base64.decode(encoded, Base64.NO_WRAP)
        if (value.size < 13) throw IllegalStateException("Encrypted Iroh identity is malformed")
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, value.copyOfRange(0, 12)))
        return cipher.doFinal(value.copyOfRange(12, value.size))
    }

    companion object { private const val KEY_ALIAS = "vibestudio-iroh-endpoint-secrets-v1" }
}

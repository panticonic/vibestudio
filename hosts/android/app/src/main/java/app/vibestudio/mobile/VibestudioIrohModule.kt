package app.vibestudio.mobile

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
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
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.withContext
import java.util.concurrent.atomic.AtomicBoolean
import java.security.KeyStore
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey as JceSecretKey
import javax.crypto.spec.GCMParameterSpec

class VibestudioIrohModule(context: ReactApplicationContext) :
    ReactContextBaseJavaModule(context) {
    private class SendEntry(val stream: SendStream, val connectionHandle: String) {
        var activeOperations = 0
        var retiring = false
        var terminalClaimed = false
    }
    private class ReceiveEntry(val stream: RecvStream, val connectionHandle: String) {
        var activeOperations = 0
        var retiring = false
        var terminalClaimed = false
    }

    private val owner = SupervisorJob()
    private val scope = CoroutineScope(owner + Dispatchers.IO)
    private val lifecycleLock = Any()
    @Volatile private var active = true
    private val endpoints = ConcurrentHashMap<String, Endpoint>()
    private val connections = ConcurrentHashMap<String, Connection>()
    private val sends = ConcurrentHashMap<String, SendEntry>()
    private val receives = ConcurrentHashMap<String, ReceiveEntry>()
    private val preferences = context.getSharedPreferences("vibestudio-iroh-identities", Context.MODE_PRIVATE)

    override fun getName() = "VibestudioIroh"

    override fun invalidate() {
        val retired = synchronized(lifecycleLock) {
            if (!active) return
            active = false
            val owned = connections.values.toList()
            connections.clear()
            sends.values.forEach { it.retiring = true }
            receives.values.forEach { it.retiring = true }
            owned
        }
        // Invalidation is the authoritative end of this React Native runtime.
        // Join its native calls before a replacement can bind the same identity.
        runBlocking(Dispatchers.IO) {
            retired.forEach { connection ->
                try { connection.close(0, byteArrayOf()) }
                catch (error: Throwable) { Log.e(TAG, "Runtime connection retirement failed", error) }
            }
            owner.cancelAndJoin()
            synchronized(lifecycleLock) {
                sends.clear()
                receives.clear()
            }
            val ownedEndpoints = synchronized(lifecycleLock) {
                endpoints.values.toList().also {
                    endpoints.clear()
                }
            }
            ownedEndpoints.forEach { endpoint ->
                try { endpoint.shutdown(); endpoint.close() }
                catch (error: Throwable) { Log.e(TAG, "Runtime endpoint retirement failed", error) }
            }
        }
        super.invalidate()
    }

    @ReactMethod
    fun createIdentity(promise: Promise) = launch(promise) {
        Log.i(TAG, "Creating encrypted device identity")
        val identityId = UUID.randomUUID().toString()
        val secret = SecretKey.generate()
        preferences.edit().putString(identityId, encrypt(secret.toBytes())).commit().also {
            if (!it) throw IllegalStateException("Encrypted identity storage refused the update")
        }
        Arguments.createMap().apply {
            putString("identityId", identityId)
            putString("deviceKey", secret.`public`().toString())
        }
            .also { Log.i(TAG, "Encrypted device identity ready") }
    }

    /** The device identity only signs; it is never bound as a transport endpoint. */
    private fun identitySecret(identityId: String): SecretKey =
        SecretKey.fromBytes(decrypt(preferences.getString(identityId, null)
            ?: throw IllegalStateException("Iroh device identity is missing")))

    @ReactMethod
    fun identityPublicKey(identityId: String, promise: Promise) = launch(promise) {
        identitySecret(identityId).`public`().toString()
    }

    @ReactMethod
    fun signWithIdentity(identityId: String, messageBase64: String, promise: Promise) =
        launch(promise) {
            val signature = identitySecret(identityId)
                .sign(Base64.decode(messageBase64, Base64.NO_WRAP))
            Base64.encodeToString(signature.toBytes(), Base64.NO_WRAP)
        }

    @ReactMethod
    fun deleteIdentity(identityId: String, promise: Promise) = launch(promise) {
        if (!preferences.edit().remove(identityId).commit()) {
            throw IllegalStateException("Encrypted identity storage refused the deletion")
        }
        null
    }

    @ReactMethod
    fun bind(endpointSecretBase64: String, relays: ReadableArray, alpnBase64: String, promise: Promise) =
        launch(promise) {
            Log.i(TAG, "Binding endpoint with ${relays.size()} configured relay(s)")
            // The secret is the process's fresh in-memory endpoint secret, never
            // the device identity; the device key delegates the endpoint it names.
            val secretBytes = Base64.decode(endpointSecretBase64, Base64.NO_WRAP)
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
            val adopted = synchronized(lifecycleLock) {
                if (!active) false else {
                    endpoints[handle] = endpoint
                    true
                }
            }
            if (!adopted) {
                withContext(NonCancellable) { endpoint.shutdown(); endpoint.close() }
                throw IllegalStateException("Iroh runtime has been invalidated")
            }
            Arguments.createMap().apply {
                putString("endpointHandle", handle)
                putString("endpointId", endpoint.id().toString())
            }
                .also { Log.i(TAG, "Endpoint bound") }
        }

    @ReactMethod
    fun shutdownEndpoint(handle: String, promise: Promise) = launch(promise) {
        endpoints[handle]?.let { endpoint ->
            withContext(NonCancellable) {
                endpoint.shutdown()
                endpoint.close()
                synchronized(lifecycleLock) {
                    endpoints.remove(handle, endpoint)
                }
            }
        }
        null
    }

    @ReactMethod
    fun dial(handle: String, endpointId: String, relayUrl: String, alpnBase64: String, promise: Promise) =
        launch(promise) {
            Log.i(TAG, "Dialing expected peer endpoint through relay")
            val endpoint = requireEndpoint(handle)
            val address = EndpointAddr(EndpointId.fromString(endpointId), relayUrl, emptyList())
            connectionResult(endpoint.connect(address, Base64.decode(alpnBase64, Base64.NO_WRAP)))
                .also { Log.i(TAG, "Peer endpoint connected") }
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
        val entry = acquireSend(handle)
        try { entry.stream.writeAll(Base64.decode(value, Base64.NO_WRAP)); null }
        finally { releaseSend(handle, entry) }
    }
    @ReactMethod fun finish(handle: String, promise: Promise) = launch(promise) {
        val entry = claimSendTerminal(handle) ?: return@launch null
        try { entry.stream.finish(); null }
        finally { releaseSend(handle, entry) }
    }
    @ReactMethod fun reset(handle: String, code: String, promise: Promise) = launch(promise) {
        val entry = claimSendTerminal(handle) ?: return@launch null
        try { entry.stream.reset(code.toULong()); null }
        finally { releaseSend(handle, entry) }
    }
    @ReactMethod fun stopped(handle: String, promise: Promise) = launch(promise) {
        val entry = acquireSend(handle)
        try { entry.stream.stopped()?.toString() }
        finally { releaseSend(handle, entry) }
    }
    @ReactMethod fun read(handle: String, maximum: Int, promise: Promise) = launch(promise) {
        if (maximum !in 1..1_048_576) throw IllegalArgumentException("Invalid bounded read size")
        val entry = acquireReceive(handle)
        try {
            val bytes = entry.stream.read(maximum.toUInt())
            if (bytes.isEmpty()) retireReceive(handle, entry)
            Base64.encodeToString(bytes, Base64.NO_WRAP)
        } finally { releaseReceive(handle, entry) }
    }
    @ReactMethod fun readExact(handle: String, length: Int, promise: Promise) = launch(promise) {
        if (length !in 0..1_048_576) throw IllegalArgumentException("Invalid exact read size")
        val entry = acquireReceive(handle)
        try { Base64.encodeToString(entry.stream.readExact(length.toUInt()), Base64.NO_WRAP) }
        finally { releaseReceive(handle, entry) }
    }
    @ReactMethod fun stop(handle: String, code: String, promise: Promise) = launch(promise) {
        val entry = claimReceiveTerminal(handle) ?: return@launch null
        try { entry.stream.stop(code.toULong()); null }
        finally { releaseReceive(handle, entry) }
    }
    @ReactMethod fun receivedReset(handle: String, promise: Promise) = launch(promise) {
        val entry = acquireReceive(handle)
        try {
            entry.stream.receivedReset()?.also { retireReceive(handle, entry) }?.toString()
        } finally { releaseReceive(handle, entry) }
    }

    @ReactMethod
    fun closeConnection(handle: String, code: String, reason: String) {
        val connection = synchronized(lifecycleLock) {
            connections.remove(handle)?.also { retireStreams(handle) }
        }
        connection?.close(code.toLong(), Base64.decode(reason, Base64.NO_WRAP))
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
        synchronized(lifecycleLock) {
            if (!active) {
                connection.close(0, byteArrayOf())
                throw IllegalStateException("Iroh runtime has been invalidated")
            }
            connections[handle] = connection
        }
        putString("connectionHandle", handle)
        putString("peerEndpointId", connection.remoteId().toString())
    }

    private suspend fun streamResult(stream: BiStream, connectionHandle: String): Any {
        val result = synchronized(lifecycleLock) {
            if (!active || !connections.containsKey(connectionHandle)) null else {
                Arguments.createMap().apply {
                    val sendHandle = UUID.randomUUID().toString()
                    val receiveHandle = UUID.randomUUID().toString()
                    sends[sendHandle] = SendEntry(stream.send(), connectionHandle)
                    receives[receiveHandle] = ReceiveEntry(stream.recv(), connectionHandle)
                    putString("sendHandle", sendHandle)
                    putString("receiveHandle", receiveHandle)
                }
            }
        }
        if (result != null) return result
        withContext(NonCancellable) {
            stream.send().reset(0u)
            stream.recv().stop(0u)
        }
        throw IllegalStateException("Iroh runtime has been invalidated")
    }

    private fun requireEndpoint(handle: String) = endpoints[handle]
        ?: throw IllegalStateException("Unknown Iroh endpoint handle")
    private fun requireConnection(handle: String) = connections[handle]
        ?: throw IllegalStateException("Unknown Iroh connection handle")
    private fun acquireSend(handle: String): SendEntry = synchronized(lifecycleLock) {
        val entry = sends[handle] ?: throw IllegalStateException("Iroh send stream is closed or unknown")
        check(active && !entry.retiring) { "Iroh send stream is closed" }
        entry.activeOperations++
        entry
    }
    private fun acquireReceive(handle: String): ReceiveEntry = synchronized(lifecycleLock) {
        val entry = receives[handle] ?: throw IllegalStateException("Iroh receive stream is closed or unknown")
        check(active && !entry.retiring) { "Iroh receive stream is closed" }
        entry.activeOperations++
        entry
    }
    private fun claimSendTerminal(handle: String): SendEntry? = synchronized(lifecycleLock) {
        val entry = sends[handle] ?: throw IllegalStateException("Iroh send stream is closed")
        check(active) { "Iroh runtime has been invalidated" }
        if (entry.terminalClaimed) return@synchronized null
        check(!entry.retiring) { "Iroh send stream is closed" }
        entry.retiring = true
        entry.terminalClaimed = true
        entry.activeOperations++
        entry
    }
    private fun claimReceiveTerminal(handle: String): ReceiveEntry? = synchronized(lifecycleLock) {
        val entry = receives[handle] ?: throw IllegalStateException("Iroh receive stream is closed")
        check(active) { "Iroh runtime has been invalidated" }
        if (entry.terminalClaimed) return@synchronized null
        check(!entry.retiring) { "Iroh receive stream is closed" }
        entry.retiring = true
        entry.terminalClaimed = true
        entry.activeOperations++
        entry
    }
    private fun retireReceive(handle: String, entry: ReceiveEntry) = synchronized(lifecycleLock) {
        entry.retiring = true
        if (entry.activeOperations == 0) receives.remove(handle, entry)
    }
    private fun releaseSend(handle: String, entry: SendEntry) = synchronized(lifecycleLock) {
        entry.activeOperations--
        check(entry.activeOperations >= 0) { "Iroh send stream operation lease underflow" }
        if (entry.retiring && entry.activeOperations == 0) sends.remove(handle, entry)
    }
    private fun releaseReceive(handle: String, entry: ReceiveEntry) = synchronized(lifecycleLock) {
        entry.activeOperations--
        check(entry.activeOperations >= 0) { "Iroh receive stream operation lease underflow" }
        if (entry.retiring && entry.activeOperations == 0) receives.remove(handle, entry)
    }
    private fun retireStreams(connectionHandle: String) {
        sends.entries.forEach { (handle, entry) ->
            if (entry.connectionHandle == connectionHandle) {
                entry.retiring = true
                if (entry.activeOperations == 0) sends.remove(handle, entry)
            }
        }
        receives.entries.forEach { (handle, entry) ->
            if (entry.connectionHandle == connectionHandle) {
                entry.retiring = true
                if (entry.activeOperations == 0) receives.remove(handle, entry)
            }
        }
    }

    private fun launch(promise: Promise, block: suspend () -> Any?) {
        val settled = AtomicBoolean(false)
        val operation = scope.launch {
            try {
                check(active) { "Iroh runtime has been invalidated" }
                val result = block()
                check(active) { "Iroh runtime has been invalidated" }
                if (settled.compareAndSet(false, true)) promise.resolve(result)
            }
            catch (error: Throwable) {
                Log.e(TAG, "Native Iroh operation failed", error)
                if (settled.compareAndSet(false, true)) promise.reject("IROH_NATIVE", error.message, error)
            }
        }
        operation.invokeOnCompletion { error ->
            if (error != null && settled.compareAndSet(false, true)) {
                promise.reject("IROH_NATIVE", error.message, error)
            }
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

    companion object {
        private const val TAG = "VibestudioIroh"
        private const val KEY_ALIAS = "vibestudio-iroh-endpoint-secrets-v1"
    }
}

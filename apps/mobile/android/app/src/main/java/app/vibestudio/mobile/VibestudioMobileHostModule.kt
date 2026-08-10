package app.vibestudio.mobile

import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.system.Os
import android.util.Base64
import android.util.Log
import com.facebook.react.ReactApplication
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import org.json.JSONObject

class VibestudioMobileHostModule(
    reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {
    private var bundleStream: java.io.FileOutputStream? = null
    private var bundleTransferFile: File? = null
    private var bundleFinalFile: File? = null
    private val assetWrites = ConcurrentHashMap<String, AssetWrite>()
    private val assetStoreLock = Any()

    override fun getName(): String = "VibestudioMobileHost"

    override fun initialize() {
        super.initialize()
        synchronized(assetStoreLock) {
            assetStagingDir().deleteRecursively()
            assetBlobsDir().mkdirs()
            assetIndexesDir().mkdirs()
        }
    }

    override fun getConstants(): MutableMap<String, Any> = hashMapOf(
        "firebaseConfigured" to BuildConfig.VIBESTUDIO_HAS_FIREBASE
    )

    @ReactMethod
    fun resetToNativeBootstrap(promise: Promise) {
        try {
            closeBundleStream()
            VibestudioBundleStore.clearActive(reactApplicationContext)
            promise.resolve(Arguments.createMap().apply {
                putBoolean("reloading", true)
            })
            Handler(Looper.getMainLooper()).post {
                try {
                    Log.i(TAG, "[VibestudioMobileSmoke] phase=native-bootstrap-reset")
                    reloadReactNative()
                } catch (error: Exception) {
                    Log.e(TAG, "Failed to reload React Native after bootstrap reset", error)
                }
            }
        } catch (error: Exception) {
            promise.reject("bootstrap_reset_failed", error.message, error)
        }
    }

    @ReactMethod
    fun consumeUsbProvisioningApproval(pairUrl: String, promise: Promise) {
        try {
            val preferences = reactApplicationContext.getSharedPreferences(
                ProvisioningActivity.PREFERENCES,
                android.content.Context.MODE_PRIVATE,
            )
            val expected = preferences.getString(ProvisioningActivity.PAIR_URL_DIGEST, null)
            val approvedAt = preferences.getLong(ProvisioningActivity.APPROVED_AT, 0L)
            preferences.edit().clear().apply()
            val actual = ProvisioningActivity.pairingApprovalDigest(pairUrl)
            val ageMs = System.currentTimeMillis() - approvedAt
            promise.resolve(
                expected != null && actual != null &&
                    MessageDigest.isEqual(
                        expected.toByteArray(Charsets.UTF_8),
                        actual.toByteArray(Charsets.UTF_8),
                    ) &&
                    ageMs in 0..USB_PROVISIONING_TTL_MS
            )
        } catch (error: Exception) {
            promise.reject("usb_provisioning_approval_failed", error.message, error)
        }
    }

    @ReactMethod
    fun appendBundleChunk(
        bytesBase64: String,
        buildKey: String,
        artifactPath: String,
        reset: Boolean,
        promise: Promise,
    ) {
        try {
            if (reset) {
                closeBundleStream()
                val safeBuildKey = safePathSegment(buildKey)
                val safeArtifact = safePathSegment(artifactPath)
                val dir = File(reactApplicationContext.cacheDir, "vibestudio-rn/$safeBuildKey")
                dir.mkdirs()
                bundleFinalFile = File(dir, safeArtifact)
                bundleTransferFile = File(dir, "$safeArtifact.transfer")
                bundleStream = java.io.FileOutputStream(bundleTransferFile, false)
            }
            val stream = bundleStream
                ?: throw IllegalStateException("appendBundleChunk called before reset")
            stream.write(Base64.decode(bytesBase64, Base64.DEFAULT))
            promise.resolve(null)
        } catch (error: Exception) {
            closeBundleStream()
            promise.reject("bundle_append_failed", error.message, error)
        }
    }

    @ReactMethod
    fun finalizeBundleWrite(integrity: String, gzip: Boolean, promise: Promise) {
        try {
            val stream = bundleStream
                ?: throw IllegalStateException("finalizeBundleWrite called before any chunk")
            stream.flush()
            stream.close()
            bundleStream = null
            val transferFile = bundleTransferFile
                ?: throw IllegalStateException("missing transfer file")
            val finalFile = bundleFinalFile
                ?: throw IllegalStateException("missing bundle file")
            bundleTransferFile = null
            bundleFinalFile = null

            val digest = MessageDigest.getInstance("SHA-256")
            val input: java.io.InputStream =
                if (gzip) java.util.zip.GZIPInputStream(java.io.FileInputStream(transferFile))
                else java.io.FileInputStream(transferFile)
            input.use { inp ->
                java.io.FileOutputStream(finalFile).use { out ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        val n = inp.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                        digest.update(buf, 0, n)
                    }
                }
            }
            transferFile.delete()
            val expected = integrity.removePrefix("sha256-")
            val actual = digest.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) }
            if (
                expected.length != 64 ||
                expected.any { it !in '0'..'9' && it !in 'a'..'f' && it !in 'A'..'F' } ||
                !actual.equals(expected, ignoreCase = true)
            ) {
                throw IllegalStateException("React Native bundle integrity mismatch")
            }
            Log.i(TAG, "[VibestudioMobileSmoke] phase=native-bundle-prepared-from-bytes")
            promise.resolve(Arguments.createMap().apply {
                putString("localPath", finalFile.absolutePath)
            })
        } catch (error: Exception) {
            closeBundleStream()
            promise.reject("bundle_finalize_failed", error.message, error)
        }
    }

    @ReactMethod
    fun activatePreparedAppBundle(localPath: String, buildKey: String, integrity: String, promise: Promise) {
        try {
            val changed = VibestudioBundleStore.activate(reactApplicationContext, localPath, buildKey, integrity)
            Log.i(TAG, "[VibestudioMobileSmoke] phase=native-bundle-activated changed=$changed")
            promise.resolve(Arguments.createMap().apply {
                putBoolean("activated", changed)
            })
        } catch (error: Exception) {
            promise.reject("bundle_activate_failed", error.message, error)
        }
    }

    @ReactMethod
    fun reloadActiveAppBundle(promise: Promise) {
        try {
            promise.resolve(Arguments.createMap().apply { putBoolean("reloading", true) })
            Handler(Looper.getMainLooper()).post {
                try {
                    Log.i(TAG, "[VibestudioMobileSmoke] phase=native-rn-reload-requested")
                    reloadReactNative()
                } catch (error: Exception) {
                    Log.e(TAG, "Failed to reload React Native after bundle activation", error)
                }
            }
        } catch (error: Exception) {
            promise.reject("bundle_reload_failed", error.message, error)
        }
    }

    @ReactMethod
    fun assetStoreLookup(namespace: ReadableMap, key: String, promise: Promise) {
        try {
            promise.resolve(synchronized(assetStoreLock) { lookupStoredAsset(namespace, key) })
        } catch (error: Exception) {
            promise.reject("asset_store_lookup_failed", error.message, error)
        }
    }

    @ReactMethod
    fun assetStoreOpenWrite(namespace: ReadableMap, key: String, promise: Promise) {
        try {
            val namespaceKey = validateAssetNamespace(namespace)
            validateAssetKey(key)
            val writeId = UUID.randomUUID().toString()
            val staging = assetStagingDir().also { it.mkdirs() }
            val transfer = File(staging, "$writeId.transfer")
            val stream = FileOutputStream(transfer, false)
            assetWrites[writeId] = AssetWrite(
                namespace = namespaceKey,
                key = key,
                transfer = transfer,
                stream = stream,
                digest = MessageDigest.getInstance("SHA-256"),
            )
            promise.resolve(writeId)
        } catch (error: Exception) {
            promise.reject("asset_store_open_failed", error.message, error)
        }
    }

    @ReactMethod
    fun assetStoreAppend(writeId: String, bytesBase64: String, promise: Promise) {
        try {
            val write = assetWrites[writeId]
                ?: throw IllegalStateException("Unknown asset-store write handle")
            val bytes = Base64.decode(bytesBase64, Base64.NO_WRAP)
            synchronized(write) {
                write.stream.write(bytes)
                write.digest.update(bytes)
                write.size += bytes.size.toLong()
            }
            promise.resolve(null)
        } catch (error: Exception) {
            abortAssetWrite(writeId)
            promise.reject("asset_store_append_failed", error.message, error)
        }
    }

    @ReactMethod
    fun assetStoreCommit(writeId: String, metadataJson: String, promise: Promise) {
        val write = assetWrites.remove(writeId)
        if (write == null) {
            promise.reject("asset_store_commit_failed", "Unknown asset-store write handle")
            return
        }
        try {
            validateAssetMetadata(metadataJson)
            val digest: String
            val size: Long
            synchronized(write) {
                write.stream.flush()
                write.stream.fd.sync()
                write.stream.close()
                digest = write.digest.digest().toHex()
                size = write.size
            }
            require(size <= MAX_ASSET_STORE_BYTES) {
                "Immutable asset exceeds the durable store byte cap"
            }
            val result = synchronized(assetStoreLock) {
                val blobs = assetBlobsDir().also { it.mkdirs() }
                val blob = File(blobs, digest)
                if (blob.exists()) {
                    if (!blob.isFile || blob.length() != size) {
                        throw IllegalStateException("Stored asset blob disagrees with its digest record")
                    }
                    write.transfer.delete()
                } else {
                    Os.rename(write.transfer.absolutePath, blob.absolutePath)
                }
                val index = readAssetIndex(write.namespace)
                val entries = index.getJSONObject("entries")
                entries.put(assetKeyDigest(write.key), JSONObject().apply {
                    put("key", write.key)
                    put("digest", digest)
                    put("size", size)
                    put("metadataJson", metadataJson)
                })
                writeAssetIndex(write.namespace, index)
                trimAssetStoreLocked(MAX_ASSET_STORE_BYTES)
                storedAssetResult(digest, size, metadataJson)
            }
            promise.resolve(result)
        } catch (error: Exception) {
            runCatching { write.stream.close() }
            write.transfer.delete()
            promise.reject("asset_store_commit_failed", error.message, error)
        }
    }

    @ReactMethod
    fun assetStoreAbort(writeId: String, promise: Promise) {
        abortAssetWrite(writeId)
        promise.resolve(null)
    }

    @ReactMethod
    fun assetStoreTrim(maxBytes: Double, promise: Promise) {
        try {
            val limit = maxBytes.toLong()
            require(limit >= 0 && limit.toDouble() == maxBytes) { "Invalid asset-store byte limit" }
            synchronized(assetStoreLock) {
                trimAssetStoreLocked(limit)
            }
            promise.resolve(null)
        } catch (error: Exception) {
            promise.reject("asset_store_trim_failed", error.message, error)
        }
    }

    @ReactMethod
    fun assetStoreClear(promise: Promise) {
        try {
            synchronized(assetStoreLock) {
                abortAllAssetWrites()
                assetIndexRoot().deleteRecursively()
                assetPayloadRoot().deleteRecursively()
                check(assetWrites.isEmpty()) { "Asset-store clear left active write handles" }
            }
            promise.resolve(null)
        } catch (error: Exception) {
            promise.reject("asset_store_clear_failed", error.message, error)
        }
    }

    private fun closeBundleStream() {
        bundleStream?.runCatching { close() }
        bundleStream = null
    }

    override fun invalidate() {
        abortAllAssetWrites()
        closeBundleStream()
        super.invalidate()
    }

    private fun lookupStoredAsset(namespace: ReadableMap, key: String): com.facebook.react.bridge.WritableMap? {
        val namespaceKey = validateAssetNamespace(namespace)
        validateAssetKey(key)
        val indexFile = assetIndexFile(namespaceKey)
        if (!indexFile.exists()) return null
        val index = readAssetIndex(namespaceKey)
        val entries = index.getJSONObject("entries")
        val entryKey = assetKeyDigest(key)
        val entry = entries.optJSONObject(entryKey) ?: return null
        if (entry.optString("key") != key) throw IllegalStateException("Asset-store index key collision")
        val digest = entry.optString("digest")
        val size = entry.optLong("size", -1L)
        val metadataJson = entry.optString("metadataJson")
        if (!ASSET_DIGEST.matches(digest) || size < 0 || metadataJson.isBlank()) {
            throw IllegalStateException("Asset-store index entry is corrupt")
        }
        validateAssetMetadata(metadataJson)
        val blob = File(assetBlobsDir(), digest).canonicalFile
        val root = assetBlobsDir().canonicalFile
        if (blob.parentFile != root || !blob.isFile || blob.length() != size) {
            // Payloads are reconstructable and deliberately excluded from OS
            // backup while indexes are retained. A restored or externally
            // truncated payload is therefore a cache miss, not corruption that
            // may permanently turn every request into a 502.
            entries.remove(entryKey)
            writeAssetIndex(namespaceKey, index)
            return null
        }
        blob.setLastModified(System.currentTimeMillis())
        return storedAssetResult(digest, size, metadataJson)
    }

    private fun storedAssetResult(
        digest: String,
        size: Long,
        metadataJson: String,
    ) = Arguments.createMap().apply {
        putString("handle", "$ASSET_HANDLE_PREFIX$digest")
        putDouble("size", size.toDouble())
        putString("metadataJson", metadataJson)
    }

    private fun validateAssetNamespace(namespace: ReadableMap): String {
        val server = namespace.getString("serverIdentity")?.lowercase()
            ?: throw IllegalArgumentException("Asset namespace is missing server identity")
        val workspace = namespace.getString("workspaceIdentity")
            ?: throw IllegalArgumentException("Asset namespace is missing workspace identity")
        require(ASSET_DIGEST.matches(server)) { "Asset namespace has invalid server identity" }
        require(workspace.isNotBlank() && workspace.length <= 512 && !workspace.contains('\u0000')) {
            "Asset namespace has invalid workspace identity"
        }
        return "$server\u0000$workspace"
    }

    private fun validateAssetKey(key: String) {
        require(key.isNotBlank() && key.length <= 16 * 1024 && !key.contains('\u0000')) {
            "Invalid asset-store key"
        }
    }

    private fun validateAssetMetadata(metadataJson: String) {
        require(metadataJson.length <= 64 * 1024) { "Asset metadata is too large" }
        val metadata = JSONObject(metadataJson)
        require(metadata.optInt("status", -1) == 200) { "Only successful assets can be stored" }
        val headers = metadata.optJSONObject("replayHeaders")
            ?: throw IllegalArgumentException("Asset metadata is missing replay headers")
        val cacheDirectives = headers.keys().asSequence()
            .filter { it.equals("cache-control", ignoreCase = true) }
            .flatMap { headers.optString(it).split(',').asSequence() }
            .map { it.trim().lowercase() }
            .toSet()
        require("immutable" in cacheDirectives && "no-store" !in cacheDirectives) {
            "Only immutable, storable assets can be stored"
        }
        require(metadata.optString("contentType").isNotBlank()) { "Asset metadata is missing content type" }
        require(metadata.has("gzip") && metadata.get("gzip") is Boolean) { "Asset metadata has invalid gzip state" }
    }

    private fun readAssetIndex(namespace: String): JSONObject {
        val file = assetIndexFile(namespace)
        if (!file.exists()) return JSONObject().apply {
            put("schemaVersion", ASSET_INDEX_SCHEMA)
            put("namespaceDigest", sha256(namespace))
            put("entries", JSONObject())
        }
        val parsed = JSONObject(file.readText(Charsets.UTF_8))
        if (
            parsed.optInt("schemaVersion") != ASSET_INDEX_SCHEMA ||
            parsed.optString("namespaceDigest") != sha256(namespace) ||
            parsed.optJSONObject("entries") == null
        ) {
            throw IllegalStateException("Asset-store index is corrupt")
        }
        return parsed
    }

    private fun writeAssetIndex(namespace: String, index: JSONObject) {
        val file = assetIndexFile(namespace)
        file.parentFile?.mkdirs()
        val temp = File(file.parentFile, "${file.name}.${UUID.randomUUID()}.tmp")
        FileOutputStream(temp, false).use { stream ->
            stream.write(index.toString().toByteArray(Charsets.UTF_8))
            stream.flush()
            stream.fd.sync()
        }
        Os.rename(temp.absolutePath, file.absolutePath)
    }

    private fun trimAssetStoreLocked(maxBytes: Long) {
        val blobs = assetBlobsDir()
        if (!blobs.exists()) return
        val files = blobs.listFiles()?.filter { it.isFile && ASSET_DIGEST.matches(it.name) } ?: emptyList()
        var total = files.sumOf { it.length() }
        if (total <= maxBytes) return
        val evicted = mutableSetOf<String>()
        for (blob in files.sortedBy { it.lastModified() }) {
            if (total <= maxBytes) break
            total -= blob.length()
            evicted += blob.name
        }
        val indexes = assetIndexesDir().listFiles()?.filter { it.isFile && it.extension == "json" } ?: emptyList()
        for (file in indexes) {
            val index = JSONObject(file.readText(Charsets.UTF_8))
            val entries = index.optJSONObject("entries")
                ?: throw IllegalStateException("Asset-store index is corrupt")
            var changed = false
            for (entryKey in entries.keys().asSequence().toList()) {
                if (evicted.contains(entries.getJSONObject(entryKey).optString("digest"))) {
                    entries.remove(entryKey)
                    changed = true
                }
            }
            if (changed) writeRawAssetIndex(file, index)
        }
        for (digest in evicted) {
            if (!File(blobs, digest).delete()) throw IllegalStateException("Could not evict stored asset")
        }
    }

    private fun writeRawAssetIndex(file: File, index: JSONObject) {
        val temp = File(file.parentFile, "${file.name}.${UUID.randomUUID()}.tmp")
        FileOutputStream(temp, false).use { stream ->
            stream.write(index.toString().toByteArray(Charsets.UTF_8))
            stream.flush()
            stream.fd.sync()
        }
        Os.rename(temp.absolutePath, file.absolutePath)
    }

    private fun abortAssetWrite(writeId: String) {
        val write = assetWrites.remove(writeId) ?: return
        synchronized(write) { runCatching { write.stream.close() } }
        write.transfer.delete()
    }

    private fun abortAllAssetWrites() {
        for (writeId in assetWrites.keys.toList()) abortAssetWrite(writeId)
    }

    /** Namespace indexes are small semantic state and intentionally participate in app backup. */
    private fun assetIndexRoot() = File(reactApplicationContext.filesDir, "vibestudio-panel-assets")
    private fun assetIndexesDir() = File(assetIndexRoot(), "indexes")

    /** Large/reconstructable payloads must never enter Android Auto Backup. */
    private fun assetPayloadRoot() = File(reactApplicationContext.noBackupFilesDir, "vibestudio-panel-assets")
    private fun assetBlobsDir() = File(assetPayloadRoot(), "blobs")
    private fun assetStagingDir() = File(assetPayloadRoot(), "staging")
    private fun assetIndexFile(namespace: String) = File(assetIndexesDir(), "${sha256(namespace)}.json")
    private fun assetKeyDigest(key: String) = sha256(key)
    private fun sha256(value: String) = MessageDigest.getInstance("SHA-256")
        .digest(value.toByteArray(Charsets.UTF_8)).toHex()
    private fun ByteArray.toHex() = joinToString("") { "%02x".format(it.toInt() and 0xff) }

    private data class AssetWrite(
        val namespace: String,
        val key: String,
        val transfer: File,
        val stream: FileOutputStream,
        val digest: MessageDigest,
        var size: Long = 0,
    )

    private fun reloadReactNative() {
        val app = reactApplicationContext.applicationContext as? ReactApplication
            ?: throw IllegalStateException("Application is not a ReactApplication")
        if (BuildConfig.IS_NEW_ARCHITECTURE_ENABLED) {
            (app.reactHost ?: throw IllegalStateException("ReactHost is unavailable"))
                .reload("Vibestudio workspace app bundle activated")
        } else {
            restartApplicationProcess()
        }
    }

    private fun restartApplicationProcess() {
        val launchIntent = reactApplicationContext.packageManager
            .getLaunchIntentForPackage(reactApplicationContext.packageName)
            ?: throw IllegalStateException("Could not resolve mobile launch intent")
        launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        reactApplicationContext.startActivity(launchIntent)
        Runtime.getRuntime().exit(0)
    }

    private fun safePathSegment(value: String): String =
        value.replace(Regex("[^A-Za-z0-9._-]"), "_").ifBlank { "bundle" }

    private companion object {
        const val TAG = "VibestudioMobileHost"
        const val USB_PROVISIONING_TTL_MS = 2 * 60 * 1000L
        const val ASSET_HANDLE_PREFIX = "vibestudio-asset-v1:"
        const val ASSET_INDEX_SCHEMA = 1
        const val MAX_ASSET_STORE_BYTES = 256L * 1024L * 1024L
        val ASSET_DIGEST = Regex("^[a-f0-9]{64}$")
    }
}

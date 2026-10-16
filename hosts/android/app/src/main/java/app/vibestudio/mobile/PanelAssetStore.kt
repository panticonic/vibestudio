package app.vibestudio.mobile

import android.content.Context
import android.system.Os
import android.util.Base64
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.ReadableMap
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import org.json.JSONObject

/**
 * The durable immutable-asset store behind the panel-hosting natives. It is
 * process-wide state: more than one client instance may hold `panel-hosting`,
 * and each owns its own [VibestudioPanelHostModule], but they share one set of
 * index files and one staging directory, so the lock and the staging cleanup
 * must be shared too.
 */
class PanelAssetStore private constructor(private val context: Context) {
    private val assetWrites = ConcurrentHashMap<String, AssetWrite>()
    private val assetStoreLock = Any()

    init {
        synchronized(assetStoreLock) {
            assetStagingDir().deleteRecursively()
            assetBlobsDir().mkdirs()
            assetIndexesDir().mkdirs()
        }
    }

    fun lookup(namespace: ReadableMap, key: String): com.facebook.react.bridge.WritableMap? =
        synchronized(assetStoreLock) { lookupStoredAsset(namespace, key) }

    fun openWrite(namespace: ReadableMap, key: String): String {
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
        return writeId
    }

    fun append(writeId: String, bytesBase64: String) {
        try {
            val write = assetWrites[writeId]
                ?: throw IllegalStateException("Unknown asset-store write handle")
            val bytes = Base64.decode(bytesBase64, Base64.NO_WRAP)
            synchronized(write) {
                write.stream.write(bytes)
                write.digest.update(bytes)
                write.size += bytes.size.toLong()
            }
        } catch (error: Exception) {
            abort(writeId)
            throw error
        }
    }

    fun commit(writeId: String, metadataJson: String): com.facebook.react.bridge.WritableMap {
        val write = assetWrites.remove(writeId)
            ?: throw IllegalStateException("Unknown asset-store write handle")
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
            return synchronized(assetStoreLock) {
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
        } catch (error: Exception) {
            runCatching { write.stream.close() }
            write.transfer.delete()
            throw error
        }
    }

    fun abort(writeId: String) {
        val write = assetWrites.remove(writeId) ?: return
        synchronized(write) { runCatching { write.stream.close() } }
        write.transfer.delete()
    }

    fun trim(maxBytes: Double) {
        val limit = maxBytes.toLong()
        require(limit >= 0 && limit.toDouble() == maxBytes) { "Invalid asset-store byte limit" }
        synchronized(assetStoreLock) {
            trimAssetStoreLocked(limit)
        }
    }

    fun clear() {
        synchronized(assetStoreLock) {
            abortAll()
            assetIndexRoot().deleteRecursively()
            assetPayloadRoot().deleteRecursively()
            check(assetWrites.isEmpty()) { "Asset-store clear left active write handles" }
        }
    }

    private fun abortAll() {
        for (writeId in assetWrites.keys.toList()) abort(writeId)
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
        val server = namespace.getString("serverEndpointId")?.lowercase()
            ?: throw IllegalArgumentException("Asset namespace is missing server Endpoint ID")
        val workspace = namespace.getString("workspaceIdentity")
            ?: throw IllegalArgumentException("Asset namespace is missing workspace identity")
        require(ASSET_DIGEST.matches(server)) { "Asset namespace has invalid server Endpoint ID" }
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

    /** Namespace indexes are small semantic state and intentionally participate in app backup. */
    private fun assetIndexRoot() = File(context.filesDir, "vibestudio-panel-assets")
    private fun assetIndexesDir() = File(assetIndexRoot(), "indexes")

    /** Large/reconstructable payloads must never enter Android Auto Backup. */
    private fun assetPayloadRoot() = File(context.noBackupFilesDir, "vibestudio-panel-assets")
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

    companion object {
        const val ASSET_HANDLE_PREFIX = "vibestudio-asset-v1:"
        const val ASSET_INDEX_SCHEMA = 1
        const val MAX_ASSET_STORE_BYTES = 256L * 1024L * 1024L
        val ASSET_DIGEST = Regex("^[a-f0-9]{64}$")

        @Volatile private var instance: PanelAssetStore? = null

        fun get(context: Context): PanelAssetStore =
            instance ?: synchronized(this) {
                instance ?: PanelAssetStore(context.applicationContext).also { instance = it }
            }
    }
}

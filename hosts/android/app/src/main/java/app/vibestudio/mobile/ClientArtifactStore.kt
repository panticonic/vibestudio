package app.vibestudio.mobile

import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * The verified artifact store: blobs keyed by their `sha256-<hex>` integrity.
 *
 * Bytes accumulate in `staging/` where no reader looks, are hashed against the
 * declared integrity at commit, and only a match is published into `blobs/` by
 * an atomic rename, so a reader never sees a partial or mismatched artifact.
 * Writers of the same integrity are independent (each has its own staging
 * file); whichever commits last replaces an identical verified blob.
 */
class ClientArtifactStore(private val root: File) {
    private val writes = ConcurrentHashMap<String, Write>()

    init {
        // Staged bytes belong to writes of a previous process; no one can resume them.
        stagingDir().deleteRecursively()
        stagingDir().mkdirs()
        blobsDir().mkdirs()
        // A materialization interrupted by process death leaves only a hidden temp tree.
        buildsDir().listFiles()?.filter { it.name.startsWith(".tmp-") }?.forEach { it.deleteRecursively() }
    }

    fun has(integrity: String): Boolean = blobFile(integrity).isFile

    fun beginWrite(integrity: String, name: String): String {
        ArtifactIntegrity.require(integrity)
        require(name.isNotEmpty() && name.length <= 255 && name != "." && name != ".." &&
            !name.contains('/') && !name.contains('\\') && !name.contains('\u0000')) {
            "Invalid artifact name"
        }
        val writeId = UUID.randomUUID().toString()
        val staged = File(stagingDir().also { it.mkdirs() }, "$writeId.transfer")
        writes[writeId] = Write(integrity, staged, FileOutputStream(staged, false), ArtifactIntegrity.newDigest())
        return writeId
    }

    fun append(writeId: String, bytes: ByteArray) {
        val write = writes[writeId] ?: throw NativeFailure(NativeFailure.INVALID_ARGUMENT, "Unknown artifact write handle")
        try {
            synchronized(write) {
                write.stream.write(bytes)
                write.digest.update(bytes)
            }
        } catch (error: Exception) {
            abort(writeId)
            throw error
        }
    }

    fun commit(writeId: String) {
        val write = writes.remove(writeId)
            ?: throw NativeFailure(NativeFailure.INVALID_ARGUMENT, "Unknown artifact write handle")
        try {
            val actual = synchronized(write) {
                write.stream.flush()
                write.stream.fd.sync()
                write.stream.close()
                ArtifactIntegrity.of(write.digest)
            }
            if (actual != write.integrity) {
                throw NativeFailure(
                    NativeFailure.INTEGRITY_MISMATCH,
                    "Staged bytes hash to $actual, expected ${write.integrity}",
                )
            }
            blobsDir().mkdirs()
            if (!write.staged.renameTo(blobFile(write.integrity))) {
                throw java.io.IOException("Could not publish artifact ${write.integrity}")
            }
        } catch (error: Throwable) {
            runCatching { write.stream.close() }
            write.staged.delete()
            throw error
        }
    }

    fun abort(writeId: String) {
        val write = writes.remove(writeId) ?: return
        synchronized(write) { runCatching { write.stream.close() } }
        write.staged.delete()
    }

    /** Abort every write still open (the host runtime's JavaScript is gone and cannot finish them). */
    fun abortAll() {
        for (writeId in writes.keys.toList()) abort(writeId)
    }

    fun list(): List<String> =
        blobsDir().listFiles()?.filter { it.isFile && INTEGRITY_NAME.matches(it.name) }?.map { it.name }?.sorted()
            ?: emptyList()

    fun remove(integrity: String) {
        val blob = blobFile(integrity)
        if (blob.exists() && !blob.delete()) throw java.io.IOException("Could not remove artifact $integrity")
    }

    fun locate(integrity: String): File {
        val blob = blobFile(integrity)
        if (!blob.isFile) throw NativeFailure(NativeFailure.ARTIFACT_MISSING, "No stored artifact $integrity")
        return blob
    }

    fun read(integrity: String): ByteArray {
        val blob = locate(integrity)
        if (blob.length() > MAX_READ_BYTES) {
            throw NativeFailure(NativeFailure.INVALID_ARGUMENT, "Artifact is too large to read whole; locate it instead")
        }
        return blob.readBytes()
    }

    /**
     * Lay one build out as `builds/<buildKey>/<path>`, each file copied from
     * the blob store and hashed as it is placed (hard links need API 26; this
     * app supports 24). The tree is assembled in a hidden temp directory and
     * renamed into place, so it is visible whole or not at all. Idempotent: an
     * existing directory whose files all still verify is returned as is.
     */
    fun materializeBuild(buildKey: String, entries: List<Pair<String, String>>): File {
        val key = safeSegment(buildKey)
        val target = File(buildsDir(), key)
        val checked = entries.map { (path, integrity) -> validatedPath(path) to ArtifactIntegrity.require(integrity) }
        if (target.isDirectory && checked.all { (path, integrity) ->
                File(target, path).let { it.isFile && ArtifactIntegrity.of(it) == integrity }
            }
        ) return target
        buildsDir().mkdirs()
        val temp = File(buildsDir(), ".tmp-${UUID.randomUUID()}")
        try {
            for ((path, integrity) in checked) {
                val source = locate(integrity)
                val destination = File(temp, path)
                destination.parentFile!!.mkdirs()
                val digest = ArtifactIntegrity.newDigest()
                source.inputStream().use { input ->
                    FileOutputStream(destination).use { output ->
                        val buffer = ByteArray(64 * 1024)
                        while (true) {
                            val read = input.read(buffer)
                            if (read < 0) break
                            digest.update(buffer, 0, read)
                            output.write(buffer, 0, read)
                        }
                        output.flush()
                        output.fd.sync()
                    }
                }
                val actual = ArtifactIntegrity.of(digest)
                if (actual != integrity) {
                    throw NativeFailure(NativeFailure.INTEGRITY_MISMATCH, "$path hashes to $actual, expected $integrity")
                }
            }
            if (!temp.exists()) temp.mkdirs()
            target.deleteRecursively()
            if (!temp.renameTo(target)) throw java.io.IOException("Could not publish build $key")
            return target
        } catch (error: Throwable) {
            temp.deleteRecursively()
            throw error
        }
    }

    /** Remove every materialized build directory not named in `keep` (and any abandoned temp tree). */
    fun retainBuilds(keep: Collection<String>) {
        val keepKeys = keep.map { safeSegment(it) }.toSet()
        buildsDir().listFiles()?.forEach {
            if (it.name !in keepKeys && !it.deleteRecursively()) throw java.io.IOException("Could not remove build ${it.name}")
        }
    }

    fun buildsRoot(): File = buildsDir()

    private fun safeSegment(value: String): String {
        if (!SEGMENT.matches(value)) throw NativeFailure(NativeFailure.INVALID_ARGUMENT, "Invalid build key")
        return value
    }

    private fun validatedPath(value: String): String {
        val valid = value.isNotEmpty() && !value.contains('\\') && !value.contains('\u0000') &&
            value.split('/').all { it.isNotEmpty() && it != "." && it != ".." }
        if (!valid) throw NativeFailure(NativeFailure.INVALID_ARGUMENT, "Invalid artifact path")
        return value
    }

    private fun blobFile(integrity: String) = File(blobsDir(), ArtifactIntegrity.require(integrity))
    private fun blobsDir() = File(root, "blobs")
    private fun stagingDir() = File(root, "staging")
    private fun buildsDir() = File(root, "builds")

    private class Write(
        val integrity: String,
        val staged: File,
        val stream: FileOutputStream,
        val digest: MessageDigest,
    )

    private companion object {
        const val MAX_READ_BYTES = 16L * 1024L * 1024L
        val SEGMENT = Regex("^[A-Za-z0-9_-]{1,200}$")
        val INTEGRITY_NAME = Regex("^sha256-[0-9a-f]{64}$")
    }
}

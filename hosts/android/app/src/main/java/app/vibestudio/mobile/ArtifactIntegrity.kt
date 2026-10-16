package app.vibestudio.mobile

import java.io.File
import java.io.FileInputStream
import java.security.MessageDigest

/** `sha256-<lowercase hex>`: the only integrity form the artifact store and client launch accept. */
object ArtifactIntegrity {
    private val PATTERN = Regex("^sha256-[0-9a-f]{64}$")

    fun require(integrity: String): String {
        if (!PATTERN.matches(integrity)) {
            throw NativeFailure(NativeFailure.INVALID_ARGUMENT, "Integrity must be sha256-<64 lowercase hex digits>")
        }
        return integrity
    }

    fun newDigest(): MessageDigest = MessageDigest.getInstance("SHA-256")

    fun of(digest: MessageDigest): String = "sha256-" + digest.digest().toHex()

    fun of(bytes: ByteArray): String = of(newDigest().also { it.update(bytes) })

    fun of(file: File): String {
        val digest = newDigest()
        FileInputStream(file).use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                digest.update(buffer, 0, read)
            }
        }
        return of(digest)
    }

    /** Re-hash `file` and refuse unless it is exactly `integrity`. */
    fun verifyFile(file: File, integrity: String) {
        require(integrity)
        if (!file.isFile) {
            throw NativeFailure(NativeFailure.ARTIFACT_MISSING, "Artifact file is missing: ${file.name}")
        }
        val actual = of(file)
        if (actual != integrity) {
            throw NativeFailure(
                NativeFailure.INTEGRITY_MISMATCH,
                "Artifact ${file.name} hashes to $actual, expected $integrity",
            )
        }
    }

    private fun ByteArray.toHex() = joinToString("") { "%02x".format(it.toInt() and 0xff) }
}

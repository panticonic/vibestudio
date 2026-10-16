package app.vibestudio.mobile

import java.io.File
import java.nio.file.Files
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test

class ClientArtifactStoreTest {
    private lateinit var root: File
    private lateinit var store: ClientArtifactStore

    @Before fun setUp() {
        root = Files.createTempDirectory("artifact-store-test").toFile()
        store = ClientArtifactStore(root)
    }

    @After fun tearDown() {
        root.deleteRecursively()
    }

    private val payload = "hello bundle".toByteArray()
    private val integrity get() = ArtifactIntegrity.of(payload)

    private fun write(bytes: ByteArray, declared: String): String {
        val id = store.beginWrite(declared, "main.bundle")
        bytes.toList().chunked(5).forEach { store.append(id, it.toByteArray()) }
        return id
    }

    @Test fun commitPublishesMatchingBytes() {
        store.commit(write(payload, integrity))
        assertTrue(store.has(integrity))
        assertEquals(listOf(integrity), store.list())
        assertEquals(payload.toList(), store.read(integrity).toList())
        assertEquals(integrity, ArtifactIntegrity.of(store.locate(integrity)))
        assertTrue(File(root, "staging").listFiles().isNullOrEmpty())
    }

    @Test fun mismatchIsDiscardedAndRejectedWithIntegrityMismatch() {
        val id = write("other bytes".toByteArray(), integrity)
        try {
            store.commit(id)
            fail("commit must reject")
        } catch (failure: NativeFailure) {
            assertEquals(NativeFailure.INTEGRITY_MISMATCH, failure.code)
        }
        assertFalse(store.has(integrity))
        assertTrue(File(root, "staging").listFiles().isNullOrEmpty())
    }

    @Test fun concurrentWritersOfOneIntegrityBothCommit() {
        val first = write(payload, integrity)
        val second = write(payload, integrity)
        store.commit(first)
        store.commit(second)
        assertEquals(listOf(integrity), store.list())
        assertEquals(payload.toList(), store.read(integrity).toList())
    }

    @Test fun uncommittedBytesAreInvisibleAndAbortDiscardsThem() {
        val id = write(payload, integrity)
        assertFalse(store.has(integrity))
        store.abort(id)
        assertTrue(File(root, "staging").listFiles().isNullOrEmpty())
    }

    @Test fun removeAndLocateMissing() {
        store.commit(write(payload, integrity))
        store.remove(integrity)
        assertFalse(store.has(integrity))
        try {
            store.locate(integrity)
            fail("locate must reject")
        } catch (failure: NativeFailure) {
            assertEquals(NativeFailure.ARTIFACT_MISSING, failure.code)
        }
    }

    @Test fun rejectsMalformedIntegrityAndNames() {
        for (bad in listOf("sha256-ABC", "sha512-" + "a".repeat(64), "../x", "sha256-" + "A".repeat(64))) {
            try {
                store.beginWrite(bad, "x")
                fail("accepted $bad")
            } catch (failure: NativeFailure) {
                assertEquals(NativeFailure.INVALID_ARGUMENT, failure.code)
            }
        }
        for (bad in listOf("", "..", "a/b", "a\\b")) {
            try {
                store.beginWrite(integrity, bad)
                fail("accepted name '$bad'")
            } catch (_: IllegalArgumentException) {
            }
        }
    }

    @Test fun verifyFileRefusesTamperedBundle() {
        store.commit(write(payload, integrity))
        val file = store.locate(integrity)
        ArtifactIntegrity.verifyFile(file, integrity)
        file.appendBytes(byteArrayOf(1))
        try {
            ArtifactIntegrity.verifyFile(file, integrity)
            fail("tampered file must be refused")
        } catch (failure: NativeFailure) {
            assertEquals(NativeFailure.INTEGRITY_MISMATCH, failure.code)
        }
    }

    @Test fun knownDigest() {
        assertEquals(
            "sha256-e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
            ArtifactIntegrity.of(ByteArray(0)),
        )
    }

    @Test fun materializeBuildLaysOutVerifiedTreeAndRetainPrunes() {
        store.commit(write(payload, integrity))
        val dir = store.materializeBuild("b1", listOf("index.bundle" to integrity, "assets/a.png" to integrity))
        assertEquals(File(root, "builds/b1"), dir)
        assertEquals(payload.toList(), File(dir, "assets/a.png").readBytes().toList())
        assertEquals(dir, store.materializeBuild("b1", listOf("index.bundle" to integrity)))
        store.materializeBuild("b2", listOf("index.bundle" to integrity))
        store.retainBuilds(listOf("b2"))
        assertFalse(File(root, "builds/b1").exists())
        assertTrue(File(root, "builds/b2/index.bundle").isFile)
    }

    @Test fun materializeBuildRejectsBadPathsAndMissingEntriesLeavingNothing() {
        store.commit(write(payload, integrity))
        for (bad in listOf("../x", "/abs", "a//b")) {
            try {
                store.materializeBuild("b3", listOf(bad to integrity))
                fail("accepted $bad")
            } catch (failure: NativeFailure) {
                assertEquals(NativeFailure.INVALID_ARGUMENT, failure.code)
            }
        }
        try {
            store.materializeBuild("b3", listOf("a" to ArtifactIntegrity.of("absent".toByteArray())))
            fail("missing entry")
        } catch (failure: NativeFailure) {
            assertEquals(NativeFailure.ARTIFACT_MISSING, failure.code)
        }
        assertFalse(File(root, "builds/b3").exists())
        assertTrue(File(root, "builds").listFiles().isNullOrEmpty())
    }
}

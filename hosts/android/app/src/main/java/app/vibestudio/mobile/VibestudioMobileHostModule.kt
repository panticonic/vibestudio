package app.vibestudio.mobile

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Base64
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.BufferedInputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.InputStream
import java.text.Normalizer
import java.security.MessageDigest
import java.util.Locale
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.zip.ZipEntry
import java.util.zip.ZipFile
import org.json.JSONObject

class VibestudioMobileHostModule(
    reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {
    private val browserImportArchives = ConcurrentHashMap<String, BrowserImportArchive>()
    private val browserImportExecutor = Executors.newSingleThreadExecutor()
    @Volatile private var browserImportPickerPromise: Promise? = null
    /**
     * The picker is launched from whichever activity is resumed (the host
     * surface or a client's task) and its result returns to that activity,
     * not to the host's React context, so results arrive through the
     * foreground-activity tracker.
     */
    private val browserImportResultListener = object : ForegroundActivities.ResultListener {
        override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?): Boolean {
            if (requestCode != BROWSER_IMPORT_PICKER_REQUEST) return false
            val promise = synchronized(this@VibestudioMobileHostModule) {
                browserImportPickerPromise.also { browserImportPickerPromise = null }
            } ?: return true
            if (resultCode != Activity.RESULT_OK) {
                promise.resolve(null)
                return true
            }
            val uri = data?.data
            if (uri == null) {
                promise.reject("browser_import_pick_failed", "The document picker did not return a file")
                return true
            }
            browserImportExecutor.execute {
                try {
                    promise.resolve(stageBrowserImportArchive(uri))
                } catch (error: Exception) {
                    promise.reject("browser_import_pick_failed", error.message, error)
                }
            }
            return true
        }
    }

    init {
        ForegroundActivities.addResultListener(browserImportResultListener)
    }

    override fun getName(): String = "VibestudioMobileHost"

    override fun initialize() {
        super.initialize()
        browserImportArchiveRoot().deleteRecursively()
        browserImportArchiveRoot().mkdirs()
    }

    override fun getConstants(): MutableMap<String, Any> = hashMapOf(
        "firebaseConfigured" to BuildConfig.VIBESTUDIO_HAS_FIREBASE,
    )

    @ReactMethod
    fun openSafariBrowserDataExport(promise: Promise) {
        promise.resolve(Arguments.createMap().apply {
            putBoolean("opened", false)
            putString("unavailableReason", "Safari browser-data export is available only on iOS")
        })
    }

    @ReactMethod
    fun pickBrowserImportArchive(promise: Promise) {
        synchronized(this) {
            if (browserImportPickerPromise != null) {
                promise.reject("browser_import_pick_busy", "A browser-import document picker is already active")
                return
            }
            browserImportPickerPromise = promise
        }
        val activity = ForegroundActivities.current()
        if (activity == null) {
            synchronized(this) { browserImportPickerPromise = null }
            promise.reject("browser_import_pick_unavailable", "No foreground activity is available")
            return
        }
        val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "*/*"
            putExtra(
                Intent.EXTRA_MIME_TYPES,
                arrayOf(
                    "application/zip",
                    "application/x-zip-compressed",
                    "text/html",
                    "text/csv",
                    "application/csv",
                    "application/json",
                    "text/json",
                ),
            )
        }
        try {
            activity.startActivityForResult(intent, BROWSER_IMPORT_PICKER_REQUEST)
        } catch (error: Exception) {
            synchronized(this) { browserImportPickerPromise = null }
            promise.reject("browser_import_pick_unavailable", error.message, error)
        }
    }

    @ReactMethod
    fun readBrowserImportEntry(
        handle: String,
        name: String,
        offset: Double,
        maxBytes: Double,
        promise: Promise,
    ) {
        browserImportExecutor.execute {
            try {
                promise.resolve(readBrowserImportEntryChunk(handle, name, offset, maxBytes))
            } catch (error: Exception) {
                promise.reject("browser_import_read_failed", error.message, error)
            }
        }
    }

    @ReactMethod
    fun releaseBrowserImportArchive(handle: String, promise: Promise) {
        browserImportExecutor.execute {
            try {
                releaseBrowserImportArchiveHandle(handle)
                promise.resolve(null)
            } catch (error: Exception) {
                promise.reject("browser_import_release_failed", error.message, error)
            }
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

    private fun stageBrowserImportArchive(uri: Uri): com.facebook.react.bridge.WritableMap {
        cleanupExpiredBrowserImportArchives()
        val resolver = reactApplicationContext.contentResolver
        var displayName = "browser-export"
        var declaredSize = -1L
        resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) {
                cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME).takeIf { it >= 0 }?.let { index ->
                    cursor.getString(index)?.takeIf { it.isNotBlank() }?.let { displayName = it }
                }
                cursor.getColumnIndex(OpenableColumns.SIZE).takeIf { it >= 0 && !cursor.isNull(it) }?.let { index ->
                    declaredSize = cursor.getLong(index)
                }
            }
        }
        require(declaredSize <= MAX_BROWSER_IMPORT_ARCHIVE_BYTES) { "Browser export exceeds the archive byte limit" }
        val handle = "$BROWSER_IMPORT_HANDLE_PREFIX${UUID.randomUUID()}"
        val file = File(browserImportArchiveRoot().also { it.mkdirs() }, handle.removePrefix(BROWSER_IMPORT_HANDLE_PREFIX))
        try {
            val input = resolver.openInputStream(uri)
                ?: throw IllegalArgumentException("The selected browser export could not be opened")
            val size = copyBrowserImportArchive(input, file)
            val entries = inspectBrowserImportArchive(file, displayName)
            val archive = BrowserImportArchive(
                file = file,
                displayName = displayName.take(MAX_BROWSER_IMPORT_DISPLAY_NAME_CHARS),
                mimeType = resolver.getType(uri),
                size = size,
                entries = entries.associateBy { it.name },
                lastAccessedAt = System.currentTimeMillis(),
            )
            browserImportArchives[handle] = archive
            return Arguments.createMap().apply {
                putString("handle", handle)
                putString("displayName", archive.displayName)
                archive.mimeType?.let { putString("mimeType", it) }
                putDouble("size", size.toDouble())
                putArray("entries", Arguments.createArray().apply {
                    entries.forEach { entry ->
                        pushMap(Arguments.createMap().apply {
                            putString("name", entry.name)
                            putDouble("size", entry.size.toDouble())
                        })
                    }
                })
            }
        } catch (error: Exception) {
            file.delete()
            throw error
        }
    }

    private fun copyBrowserImportArchive(input: InputStream, destination: File): Long {
        var total = 0L
        BufferedInputStream(input).use { source ->
            FileOutputStream(destination, false).use { output ->
                val buffer = ByteArray(64 * 1024)
                while (true) {
                    val count = source.read(buffer)
                    if (count < 0) break
                    total += count
                    require(total <= MAX_BROWSER_IMPORT_ARCHIVE_BYTES) { "Browser export exceeds the archive byte limit" }
                    output.write(buffer, 0, count)
                }
                output.flush()
                output.fd.sync()
            }
        }
        require(total > 0) { "The selected browser export is empty" }
        return total
    }

    private fun inspectBrowserImportArchive(file: File, displayName: String): List<BrowserImportEntry> {
        val isZip = FileInputStream(file).use { input ->
            val signature = ByteArray(4)
            input.read(signature) == signature.size &&
                signature[0] == 0x50.toByte() && signature[1] == 0x4b.toByte() &&
                ((signature[2] == 0x03.toByte() && signature[3] == 0x04.toByte()) ||
                    (signature[2] == 0x05.toByte() && signature[3] == 0x06.toByte()))
        }
        if (!isZip) {
            val extension = displayName.substringAfterLast('.', "").lowercase(Locale.ROOT)
            require(extension in BROWSER_IMPORT_SINGLE_FILE_EXTENSIONS) {
                "Select a ZIP, HTML, CSV, or JSON browser export"
            }
            return listOf(BrowserImportEntry(validateBrowserImportEntryName(displayName), file.length(), null))
        }
        val entries = mutableListOf<BrowserImportEntry>()
        val canonicalNames = mutableSetOf<String>()
        var expandedBytes = 0L
        ZipFile(file).use { zip ->
            val enumeration = zip.entries()
            var seen = 0
            while (enumeration.hasMoreElements()) {
                val entry = enumeration.nextElement()
                seen += 1
                require(seen <= MAX_BROWSER_IMPORT_ENTRY_COUNT) { "Browser export contains too many archive entries" }
                val name = validateBrowserImportEntryName(entry.name)
                val canonical = canonicalBrowserImportEntryName(name)
                require(canonicalNames.add(canonical)) { "Browser export contains duplicate archive paths" }
                if (entry.isDirectory) continue
                require(entry.method == ZipEntry.STORED || entry.method == ZipEntry.DEFLATED) {
                    "Browser export uses an unsupported ZIP compression method"
                }
                val size = entry.size
                val compressedSize = entry.compressedSize
                require(size >= 0 && compressedSize >= 0) { "Browser export has entries with unknown sizes" }
                require(size <= MAX_BROWSER_IMPORT_ENTRY_BYTES) { "Browser export contains an oversized entry" }
                expandedBytes = Math.addExact(expandedBytes, size)
                require(expandedBytes <= MAX_BROWSER_IMPORT_EXPANDED_BYTES) { "Browser export expands beyond the byte limit" }
                if (size > BROWSER_IMPORT_RATIO_GRACE_BYTES) {
                    require(compressedSize > 0 && size <= compressedSize * MAX_BROWSER_IMPORT_COMPRESSION_RATIO) {
                        "Browser export contains a suspiciously compressed entry"
                    }
                }
                entries += BrowserImportEntry(name, size, entry.name)
            }
        }
        require(entries.isNotEmpty()) { "Browser export ZIP contains no files" }
        return entries
    }

    private fun validateBrowserImportEntryName(value: String): String {
        require(value.isNotBlank() && value.length <= MAX_BROWSER_IMPORT_ENTRY_NAME_CHARS && !value.contains('\u0000')) {
            "Browser export contains an invalid archive path"
        }
        val normalized = Normalizer.normalize(value.replace('\\', '/'), Normalizer.Form.NFC).removeSuffix("/")
        require(!normalized.startsWith('/') && !WINDOWS_ABSOLUTE_PATH.containsMatchIn(normalized)) {
            "Browser export contains an absolute archive path"
        }
        val parts = normalized.split('/')
        require(parts.none { it.isEmpty() || it == "." || it == ".." }) {
            "Browser export contains a traversing archive path"
        }
        require(normalized.none { it.code < 0x20 || it.code == 0x7f }) {
            "Browser export contains control characters in an archive path"
        }
        return normalized
    }

    private fun canonicalBrowserImportEntryName(value: String) =
        validateBrowserImportEntryName(value).lowercase(Locale.ROOT)

    private fun readBrowserImportEntryChunk(
        handle: String,
        requestedName: String,
        offsetValue: Double,
        maxBytesValue: Double,
    ): com.facebook.react.bridge.WritableMap {
        cleanupExpiredBrowserImportArchives()
        require(handle.startsWith(BROWSER_IMPORT_HANDLE_PREFIX)) { "Invalid browser-import archive handle" }
        val offset = exactNonNegativeLong(offsetValue, "offset")
        val maxBytesLong = exactNonNegativeLong(maxBytesValue, "maxBytes")
        require(maxBytesLong in 1..MAX_BROWSER_IMPORT_READ_BYTES.toLong()) { "Browser-import read size is out of bounds" }
        val archive = browserImportArchives[handle]
            ?: throw IllegalStateException("Browser-import archive handle is unavailable or expired")
        require(archive.file.isFile && archive.file.length() == archive.size) {
            "Browser-import archive changed after validation"
        }
        val name = validateBrowserImportEntryName(requestedName)
        val entry = archive.entries[name] ?: throw IllegalArgumentException("Unknown browser-import archive entry")
        require(offset <= entry.size) { "Browser-import read offset exceeds the entry size" }
        val expectedCount = minOf(maxBytesLong, entry.size - offset).toInt()
        val bytes = if (entry.zipName != null) {
            ZipFile(archive.file).use { zip ->
                val zipEntry = zip.getEntry(entry.zipName)
                    ?: throw IllegalStateException("Browser-import archive changed after validation")
                zip.getInputStream(zipEntry).use { input ->
                    skipFully(input, offset)
                    readExactlyUpTo(input, expectedCount)
                }
            }
        } else {
            FileInputStream(archive.file).use { input ->
                skipFully(input, offset)
                readExactlyUpTo(input, expectedCount)
            }
        }
        require(bytes.size == expectedCount) { "Browser-import archive ended before its declared entry size" }
        archive.lastAccessedAt = System.currentTimeMillis()
        return Arguments.createMap().apply {
            putString("dataBase64", Base64.encodeToString(bytes, Base64.NO_WRAP))
            putBoolean("eof", offset + bytes.size >= entry.size)
        }
    }

    private fun exactNonNegativeLong(value: Double, field: String): Long {
        require(value.isFinite() && value >= 0 && value <= Long.MAX_VALUE.toDouble()) { "Invalid browser-import $field" }
        val result = value.toLong()
        require(result.toDouble() == value) { "Invalid browser-import $field" }
        return result
    }

    private fun skipFully(input: InputStream, byteCount: Long) {
        var remaining = byteCount
        while (remaining > 0) {
            val skipped = input.skip(remaining)
            if (skipped > 0) {
                remaining -= skipped
            } else {
                require(input.read() >= 0) { "Browser-import archive ended before the requested offset" }
                remaining -= 1
            }
        }
    }

    private fun readExactlyUpTo(input: InputStream, byteCount: Int): ByteArray {
        val result = ByteArray(byteCount)
        var offset = 0
        while (offset < byteCount) {
            val count = input.read(result, offset, byteCount - offset)
            if (count < 0) break
            offset += count
        }
        return if (offset == byteCount) result else result.copyOf(offset)
    }

    private fun releaseBrowserImportArchiveHandle(handle: String) {
        require(handle.startsWith(BROWSER_IMPORT_HANDLE_PREFIX)) { "Invalid browser-import archive handle" }
        val archive = browserImportArchives.remove(handle) ?: return
        check(!archive.file.exists() || archive.file.delete()) { "Could not delete staged browser-import archive" }
    }

    private fun cleanupExpiredBrowserImportArchives() {
        val now = System.currentTimeMillis()
        for ((handle, archive) in browserImportArchives.entries) {
            if (now - archive.lastAccessedAt >= BROWSER_IMPORT_TTL_MS && browserImportArchives.remove(handle, archive)) {
                archive.file.delete()
            }
        }
        val activeFiles = browserImportArchives.values.mapTo(mutableSetOf()) { it.file.name }
        browserImportArchiveRoot().listFiles()?.forEach { file ->
            if (file.name !in activeFiles && (now - file.lastModified() >= BROWSER_IMPORT_TTL_MS || !file.isFile)) {
                file.deleteRecursively()
            }
        }
    }

    private fun browserImportArchiveRoot() =
        File(reactApplicationContext.noBackupFilesDir, "vibestudio-browser-import")

    override fun invalidate() {
        synchronized(this) {
            browserImportPickerPromise?.reject("browser_import_pick_cancelled", "The browser-import picker was cancelled")
            browserImportPickerPromise = null
        }
        browserImportArchives.keys.toList().forEach(::releaseBrowserImportArchiveHandle)
        browserImportExecutor.shutdownNow()
        ForegroundActivities.removeResultListener(browserImportResultListener)
        super.invalidate()
    }

    private data class BrowserImportEntry(
        val name: String,
        val size: Long,
        val zipName: String?,
    )

    private data class BrowserImportArchive(
        val file: File,
        val displayName: String,
        val mimeType: String?,
        val size: Long,
        val entries: Map<String, BrowserImportEntry>,
        @Volatile var lastAccessedAt: Long,
    )

    private companion object {
        const val USB_PROVISIONING_TTL_MS = 2 * 60 * 1000L
        const val BROWSER_IMPORT_PICKER_REQUEST = 0x4252
        const val BROWSER_IMPORT_HANDLE_PREFIX = "vibestudio-browser-import-v1:"
        const val BROWSER_IMPORT_TTL_MS = 60L * 60L * 1000L
        const val MAX_BROWSER_IMPORT_ARCHIVE_BYTES = 512L * 1024L * 1024L
        const val MAX_BROWSER_IMPORT_EXPANDED_BYTES = 2L * 1024L * 1024L * 1024L
        const val MAX_BROWSER_IMPORT_ENTRY_BYTES = 512L * 1024L * 1024L
        const val MAX_BROWSER_IMPORT_ENTRY_COUNT = 20_000
        const val MAX_BROWSER_IMPORT_COMPRESSION_RATIO = 200L
        const val BROWSER_IMPORT_RATIO_GRACE_BYTES = 1024L * 1024L
        const val MAX_BROWSER_IMPORT_READ_BYTES = 512 * 1024
        const val MAX_BROWSER_IMPORT_ENTRY_NAME_CHARS = 4 * 1024
        const val MAX_BROWSER_IMPORT_DISPLAY_NAME_CHARS = 512
        val BROWSER_IMPORT_SINGLE_FILE_EXTENSIONS = setOf("html", "htm", "csv", "json")
        val WINDOWS_ABSOLUTE_PATH = Regex("^[A-Za-z]:/")
    }
}

package app.vibestudio.mobile

import android.content.Intent
import android.net.Uri
import android.util.Base64
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableArray
import com.facebook.react.bridge.ReadableMap
import java.io.File
import java.util.concurrent.Executors

/**
 * `VibestudioHostRuntime`: the native half of the host runtime contract
 * (hosts/react-native/src/host/nativeHostRuntime.ts). Exists in the host
 * instance only. It carries JSON between client instances and the host
 * runtime's JavaScript without interpreting it, owns client instance
 * lifecycle, and re-verifies bundle integrity immediately before loading one.
 */
class VibestudioHostRuntimeModule(
    reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {
    private val store get() = HostRuntime.artifactStore(reactApplicationContext)

    // Hashing a bundle is blocking I/O; it must not run on the native-module or UI thread.
    private val io = Executors.newCachedThreadPool()

    override fun getName(): String = "VibestudioHostRuntime"

    override fun initialize() {
        super.initialize()
        HostRuntime.attach(reactApplicationContext)
    }

    override fun invalidate() {
        HostRuntime.detach(reactApplicationContext)
        io.shutdown()
        super.invalidate()
    }

    @ReactMethod
    fun markReady(promise: Promise) = done(promise, "host_runtime_failed") {
        HostRuntime.broker.markReady()
    }

    @ReactMethod
    fun startClient(spec: ReadableMap, promise: Promise) = onIo(promise) {
        val parsed = ClientSpec.parse(spec)
        verifiedBundle(parsed.bundle)
        ClientInstances.onMain {
            ClientInstances.start(parsed) { failure -> settleStart(promise, failure) }
        }
    }

    @ReactMethod
    fun reloadClient(tag: String, bundle: ReadableMap, promise: Promise) = onIo(promise) {
        val next = ClientBundle.parse(bundle)
        verifiedBundle(next)
        ClientInstances.onMain {
            ClientInstances.reload(tag, next) { failure -> settleStart(promise, failure) }
        }
    }

    @ReactMethod
    fun stopClient(tag: String, reason: String, promise: Promise) = done(promise, "stop_client_failed") {
        ClientInstances.onMain { ClientInstances.stop(tag) }
    }

    @ReactMethod
    fun focusClient(tag: String, promise: Promise) {
        ClientInstances.onMain {
            val failure = ClientInstances.focus(tag)
            if (failure == null) promise.resolve(null) else reject(promise, failure)
        }
    }

    @ReactMethod
    fun showHostSurface(promise: Promise) = done(promise, "show_host_surface_failed") {
        ClientInstances.onMain { ClientInstances.showHostSurface() }
    }

    /**
     * Ask the launcher to pin a shortcut that opens `link`. Resolves false when
     * the launcher cannot pin shortcuts; the OS confirms with the person.
     */
    @ReactMethod
    fun requestPinShortcut(shortcutId: String, label: String, link: String, promise: Promise) =
        reply(promise, "pin_shortcut_failed") {
            val context = reactApplicationContext
            if (!ShortcutManagerCompat.isRequestPinShortcutSupported(context)) {
                false
            } else {
                val shortcut = ShortcutInfoCompat.Builder(context, shortcutId)
                    .setShortLabel(label)
                    .setIcon(IconCompat.createWithResource(context, R.mipmap.ic_launcher))
                    .setIntent(
                        Intent(Intent.ACTION_VIEW, Uri.parse(link)).setClass(context, IngressActivity::class.java),
                    )
                    .build()
                ShortcutManagerCompat.requestPinShortcut(context, shortcut, null)
            }
        }

    @ReactMethod
    fun respond(tag: String, requestId: String, resultJson: String, promise: Promise) =
        done(promise, "respond_failed") {
            // A request whose client has gone is already settled; a late answer is not an error.
            HostRuntime.broker.respond(tag, requestId, resultJson)
        }

    @ReactMethod
    fun reject(tag: String, requestId: String, code: String, message: String, promise: Promise) =
        done(promise, "reject_failed") {
            HostRuntime.broker.reject(tag, requestId, code, message)
        }

    @ReactMethod
    fun emit(tag: String, eventJson: String, promise: Promise) = done(promise, "emit_failed") {
        ClientInstances.onMain { ClientInstances.deliver(tag, eventJson) }
    }

    // --- Verified artifact store ---

    @ReactMethod
    fun artifactHas(integrity: String, promise: Promise) =
        reply(promise, "artifact_failed") { store.has(ArtifactIntegrity.require(integrity)) }

    @ReactMethod
    fun artifactBeginWrite(integrity: String, name: String, promise: Promise) =
        reply(promise, "artifact_failed") { store.beginWrite(integrity, name) }

    @ReactMethod
    fun artifactAppend(writeId: String, bytesBase64: String, promise: Promise) =
        done(promise, "artifact_failed") { store.append(writeId, Base64.decode(bytesBase64, Base64.NO_WRAP)) }

    @ReactMethod
    fun artifactCommit(writeId: String, promise: Promise) = onIo(promise) { store.commit(writeId); promise.resolve(null) }

    @ReactMethod
    fun artifactAbort(writeId: String, promise: Promise) = done(promise, "artifact_failed") { store.abort(writeId) }

    @ReactMethod
    fun artifactList(promise: Promise) = reply(promise, "artifact_failed") {
        Arguments.fromList(store.list())
    }

    @ReactMethod
    fun artifactRemove(integrity: String, promise: Promise) =
        done(promise, "artifact_failed") { store.remove(ArtifactIntegrity.require(integrity)) }

    @ReactMethod
    fun artifactLocate(integrity: String, promise: Promise) = reply(promise, "artifact_failed") {
        store.locate(integrity).absolutePath
    }

    @ReactMethod
    fun artifactRead(integrity: String, promise: Promise) = onIo(promise) {
        promise.resolve(Base64.encodeToString(store.read(integrity), Base64.NO_WRAP))
    }

    @ReactMethod
    fun artifactMaterializeBuild(buildKey: String, entries: ReadableArray, promise: Promise) = onIo(promise) {
        val parsed = (0 until entries.size()).map { index ->
            val entry = entries.getMap(index) ?: throw NativeFailure(NativeFailure.INVALID_ARGUMENT, "Invalid build entry")
            ClientBundle.string(entry, "path") to ClientBundle.string(entry, "integrity")
        }
        promise.resolve(store.materializeBuild(buildKey, parsed).absolutePath)
    }

    @ReactMethod
    fun artifactRetainBuilds(keep: ReadableArray, promise: Promise) = onIo(promise) {
        store.retainBuilds((0 until keep.size()).map { keep.getString(it) ?: "" })
        promise.resolve(null)
    }

    // --- helpers ---

    /**
     * The bundle must lie inside its materialized build directory (a direct
     * child of the store's builds root, named by the build key), and must
     * still hash to its integrity.
     */
    private fun verifiedBundle(bundle: ClientBundle) {
        val assets = File(bundle.assetsRoot).canonicalFile
        val file = File(bundle.bundlePath).canonicalFile
        if (assets.parentFile != store.buildsRoot().canonicalFile || assets.name != bundle.buildKey ||
            !file.path.startsWith(assets.path + File.separator)
        ) {
            throw NativeFailure(NativeFailure.INVALID_ARGUMENT, "Bundle is not inside the materialized build ${bundle.buildKey}")
        }
        ArtifactIntegrity.verifyFile(file, bundle.integrity)
    }

    /** Resolve `promise` with what `block` returns (null for void); reject with its failure. */
    private fun done(promise: Promise, fallbackCode: String, block: () -> Unit) =
        reply(promise, fallbackCode) { block(); null }

    private fun reply(promise: Promise, fallbackCode: String, block: () -> Any?) {
        try {
            promise.resolve(block())
        } catch (error: Throwable) {
            reject(promise, error, fallbackCode)
        }
    }

    private fun onIo(promise: Promise, block: () -> Unit) {
        try {
            io.execute {
                try {
                    block()
                } catch (error: Throwable) {
                    reject(promise, error)
                }
            }
        } catch (error: Throwable) {
            reject(promise, error)
        }
    }

    private fun settleStart(promise: Promise, failure: NativeFailure?) {
        if (failure == null) promise.resolve(null) else reject(promise, failure)
    }

    private fun reject(promise: Promise, error: Throwable, fallbackCode: String = "host_runtime_failed") {
        val code = (error as? NativeFailure)?.code ?: fallbackCode
        promise.reject(code, error.message ?: error.javaClass.simpleName, error)
    }
}

package app.vibestudio.mobile

import android.content.Context
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.modules.core.DeviceEventManagerModule
import java.io.File
import org.json.JSONObject

/**
 * Process-wide state of the host runtime: the host instance's React context
 * (while one is attached), the broker core, and the verified artifact store.
 * Client instances and activities reach the host runtime only through here.
 */
object HostRuntime {
    /** Device event the host runtime's JavaScript listens to; payload is one JSON string. */
    const val EVENT = "VibestudioHostRuntimeEvent"

    val broker = ClientBrokerCore { request ->
        emitToHost(
            JSONObject()
                .put("type", "client-request")
                .put("tag", request.tag)
                .put("requestId", request.requestId)
                .put("method", request.method)
                .put("argsJson", request.argsJson),
        )
    }

    @Volatile private var hostContext: ReactApplicationContext? = null
    @Volatile private var store: ClientArtifactStore? = null

    @Synchronized
    fun artifactStore(context: Context): ClientArtifactStore =
        store ?: ClientArtifactStore(File(context.applicationContext.noBackupFilesDir, "vibestudio-client-artifacts"))
            .also { store = it }

    fun attach(context: ReactApplicationContext) {
        hostContext = context
    }

    /** The host instance's React context is being destroyed; nothing it was asked can be answered now. */
    fun detach(context: ReactApplicationContext) {
        if (hostContext !== context) return
        hostContext = null
        broker.hostDetached("host-unavailable", "The host runtime restarted before answering this request")
        store?.abortAll()
    }

    fun emitToHost(event: JSONObject) {
        val context = hostContext ?: return
        if (!context.hasActiveReactInstance()) return
        context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(EVENT, event.toString())
    }

    fun emitLifecycle(tag: String, state: String, message: String?) {
        emitToHost(
            JSONObject().put("type", "client-lifecycle").put("tag", tag).put("state", state)
                .also { if (message != null) it.put("message", message) },
        )
    }
}

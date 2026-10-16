package app.vibestudio.mobile

import android.app.ActivityManager
import android.app.Application
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import com.facebook.react.ReactInstanceEventListener
import com.facebook.react.bridge.ReactContext
import com.facebook.react.modules.core.DeviceEventManagerModule
import org.json.JSONObject

/**
 * The client instances this process runs and the activities that show them.
 * Everything here is confined to the main thread (`onMain`), which also is the
 * thread React Native requires for creating and destroying instance managers.
 *
 * Ownership of teardown, by cause:
 *  - the host calls stopClient: nothing is emitted, the host already knows;
 *  - the person closes the client's task, or the instance crashes: native has
 *    torn the instance down and emits `client-lifecycle`;
 *  - a reload replaces the instance in place; its activity is recreated onto it.
 */
object ClientInstances {
    /** `CLIENT_ROOT_COMPONENT` and `CLIENT_EVENT_NAME` of `@vibestudio/rn-client-api/protocol`. */
    const val CLIENT_ROOT_COMPONENT = "VibestudioClient"
    const val CLIENT_EVENT_NAME = "VibestudioClientEvent"

    const val EXTRA_TAG = "app.vibestudio.mobile.client.tag"
    const val EXTRA_CLIENT_ID = "app.vibestudio.mobile.client.clientId"
    const val EXTRA_TITLE = "app.vibestudio.mobile.client.title"

    /** A link to open when the activity is created (a bubble): the activity shows the client itself. */
    const val EXTRA_LINK = "app.vibestudio.mobile.client.link"

    private class Instance(val host: ClientReactNativeHost) {
        val spec get() = host.spec
        var startDone: ((NativeFailure?) -> Unit)? = null
    }

    private val main = Handler(Looper.getMainLooper())
    private lateinit var application: Application
    private val instances = HashMap<String, Instance>()
    private val activities = HashMap<String, MutableSet<ClientActivity>>()
    private val restoreRequested = HashSet<String>()

    fun init(app: Application) {
        application = app
    }

    private val idle by lazy { IdleReactNativeHost(application) }

    /** The host an activity binds to while it has no instance: it never creates one. */
    fun idleHost(): IdleReactNativeHost = idle

    fun onMain(block: () -> Unit) {
        if (Looper.myLooper() === Looper.getMainLooper()) block() else main.post(block)
    }

    fun start(spec: ClientSpec, done: (NativeFailure?) -> Unit) {
        // "Starting a tag that already runs reloads it."
        instances.remove(spec.tag)?.let { retire(it, "superseded by a new start") }
        launch(spec, done, existingActivities = activities[spec.tag].orEmpty().isNotEmpty())
    }

    fun reload(tag: String, bundle: ClientBundle, done: (NativeFailure?) -> Unit) {
        val running = instances.remove(tag)
        if (running == null) {
            done(NativeFailure(NativeFailure.CLIENT_NOT_RUNNING, "No client instance for $tag"))
            return
        }
        val spec = running.spec.withBundle(bundle)
        retire(running, "reloaded onto ${bundle.buildKey}")
        launch(spec, done, existingActivities = activities[tag].orEmpty().isNotEmpty())
    }

    private fun launch(spec: ClientSpec, done: (NativeFailure?) -> Unit, existingActivities: Boolean) {
        val host = ClientReactNativeHost(application, spec, ::crashed)
        val instance = Instance(host).also { it.startDone = done }
        instances[spec.tag] = instance
        restoreRequested.remove(spec.tag)
        try {
            val manager = host.reactInstanceManager
            manager.addReactInstanceEventListener(object : ReactInstanceEventListener {
                override fun onReactContextInitialized(context: ReactContext) {
                    onMain { settleStart(instance, null) }
                }
            })
            manager.createReactContextInBackground()
        } catch (error: Exception) {
            instances.remove(spec.tag)
            runCatching { host.clear() }
            done(NativeFailure("client-start-failed", error.message ?: "Could not create the client instance", error))
            return
        }
        if (existingActivities) {
            // Activities bind their host at creation; recreate them onto this one.
            activities[spec.tag]?.toList()?.forEach { if (it.boundHost !== host) it.recreate() }
        } else {
            startActivity(spec)
        }
    }

    fun stop(tag: String) {
        restoreRequested.remove(tag)
        instances.remove(tag)?.let { retire(it, "stopped by the host") }
        HostRuntime.broker.dropClient(tag, "client-stopped", "The client was stopped")
        // Includes activities still waiting for a client that will not come.
        activities[tag]?.toList()?.forEach { it.finishAndRemoveTask() }
    }

    fun focus(tag: String): NativeFailure? {
        val instance = instances[tag]
            ?: return NativeFailure(NativeFailure.CLIENT_NOT_RUNNING, "No client instance for $tag")
        val activity = activities[tag]?.firstOrNull { !it.isFinishing }
        if (activity == null) {
            startActivity(instance.spec)
            return null
        }
        val tasks = application.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        @Suppress("DEPRECATION")
        tasks.appTasks.firstOrNull { it.taskInfo.id == activity.taskId }?.moveToFront()
        return null
    }

    fun showHostSurface() {
        application.startActivity(
            Intent(application, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
    }

    /** Deliver one host event to the client's JavaScript; a stopped or not-yet-running tag drops it. */
    fun deliver(tag: String, eventJson: String) {
        val host = instances[tag]?.host ?: return
        if (!host.hasInstance()) return
        val context = host.reactInstanceManager.currentReactContext ?: return
        if (!context.hasActiveReactInstance()) return
        context.getJSModule(DeviceEventManagerModule.RCTDeviceEventEmitter::class.java)
            .emit(CLIENT_EVENT_NAME, eventJson)
    }

    // --- activities ---

    /** The host this activity should show: the live instance for its tag, or null while it waits for the host. */
    fun attach(activity: ClientActivity, tag: String): ClientReactNativeHost? {
        activities.getOrPut(tag) { LinkedHashSet() }.add(activity)
        return instances[tag]?.host
    }

    /**
     * The OS entered the process through this client's task and there is no
     * instance for it. The host launches the client again once it is ready;
     * the activity is recreated onto the instance when it starts.
     */
    fun requestRestore(tag: String, clientId: String) {
        if (!restoreRequested.add(tag)) return
        HostRuntime.broker.afterReady(tag) {
            HostRuntime.emitToHost(
                JSONObject().put("type", "client-restore").put("tag", tag).put("clientId", clientId),
            )
        }
    }

    fun activityDestroyed(activity: ClientActivity, tag: String, closedByPerson: Boolean) {
        val remaining = activities[tag]?.also { it.remove(activity) }
        if (remaining.isNullOrEmpty()) {
            activities.remove(tag)
            restoreRequested.remove(tag)
        }
        if (!closedByPerson || !remaining.isNullOrEmpty()) return
        val instance = instances[tag]
        if (instance == null || instance.host !== activity.boundHost) {
            // Waiting activity, or an activity of an instance that was already replaced: nothing to tear down.
            HostRuntime.broker.dropClient(tag, "client-closed", "The client's task was closed")
            return
        }
        instances.remove(tag)
        retire(instance, "task closed")
        HostRuntime.broker.dropClient(tag, "client-closed", "The client's task was closed")
        HostRuntime.emitLifecycle(tag, "stopped", null)
    }

    // --- internals ---

    private fun crashed(host: ClientReactNativeHost, error: Exception) = onMain {
        val tag = host.spec.tag
        val instance = instances[tag]?.takeIf { it.host === host } ?: return@onMain
        instances.remove(tag)
        val message = error.message ?: error.javaClass.name
        val starting = instance.startDone != null
        retire(instance, message, NativeFailure("client-start-failed", message, error))
        HostRuntime.broker.dropClient(tag, "client-crashed", message)
        // A crash before the client's JavaScript started is the rejection of its start; later it is an event.
        if (!starting) HostRuntime.emitLifecycle(tag, "crashed", message)
        activities[tag]?.toList()?.forEach { it.finishAndRemoveTask() }
    }

    private fun retire(instance: Instance, reason: String, failure: NativeFailure? = null) {
        runCatching { instance.host.clear() }
        settleStart(instance, failure ?: NativeFailure("client-start-failed", "Client instance retired: $reason"))
    }

    private fun settleStart(instance: Instance, failure: NativeFailure?) {
        val done = instance.startDone ?: return
        instance.startDone = null
        done(failure)
    }

    private fun startActivity(spec: ClientSpec) {
        application.startActivity(
            Intent(application, ClientActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_DOCUMENT or Intent.FLAG_ACTIVITY_MULTIPLE_TASK)
                .putExtra(EXTRA_TAG, spec.tag)
                .putExtra(EXTRA_CLIENT_ID, spec.clientId)
                .putExtra(EXTRA_TITLE, spec.title),
        )
    }
}

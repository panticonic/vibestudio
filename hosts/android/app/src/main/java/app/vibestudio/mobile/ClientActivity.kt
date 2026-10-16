package app.vibestudio.mobile

import android.app.ActivityManager
import android.content.Intent
import android.os.Bundle
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.ReactNativeHost
import org.json.JSONObject

/**
 * Shows one client instance in its own task (own Recents entry, labelled with
 * the client's title). The instance belongs to the tag in the intent extras,
 * not to this activity: the activity binds to whatever instance the tag has
 * when it is created, and is recreated when the host replaces it.
 *
 * When the OS restores the task into a fresh process there is no instance yet.
 * The activity then waits for the host runtime to start the client (asking it
 * through the broker once it is ready) and is recreated onto the instance when
 * it appears. Nothing here has a timeout; the host's start, stop or failure
 * is what ends the wait.
 */
class ClientActivity : ReactActivity() {
    private lateinit var tag: String
    private var clientId: String = ""

    /** The instance this activity was created against; null while it waits for the host. */
    var boundHost: ClientReactNativeHost? = null
        private set

    override fun getMainComponentName(): String = ClientInstances.CLIENT_ROOT_COMPONENT

    override fun createReactActivityDelegate(): ReactActivityDelegate =
        object : ReactActivityDelegate(this, mainComponentName) {
            override fun getReactNativeHost(): ReactNativeHost =
                boundHost ?: ClientInstances.idleHost()

            override fun loadApp(appKey: String?) {
                if (boundHost != null) super.loadApp(appKey)
            }
        }

    override fun onCreate(savedInstanceState: Bundle?) {
        val requestedTag = intent.getStringExtra(ClientInstances.EXTRA_TAG)
        if (requestedTag == null) {
            // Not launched by the host runtime: there is nothing to show.
            super.onCreate(savedInstanceState)
            finishAndRemoveTask()
            return
        }
        tag = requestedTag
        clientId = intent.getStringExtra(ClientInstances.EXTRA_CLIENT_ID).orEmpty()
        intent.getStringExtra(ClientInstances.EXTRA_TITLE)?.let {
            @Suppress("DEPRECATION")
            setTaskDescription(ActivityManager.TaskDescription(it))
        }
        boundHost = ClientInstances.attach(this, tag)
        super.onCreate(savedInstanceState)
        val link = intent.getStringExtra(ClientInstances.EXTRA_LINK)
        when {
            // A bubble: the link opens the conversation in the client, starting
            // the client into this activity when it is not running, and it is
            // not brought to a task of its own.
            link != null && savedInstanceState == null ->
                HostIngress.forward(JSONObject().put("type", "link").put("url", link).put("focus", false))
            boundHost == null -> ClientInstances.requestRestore(tag, clientId)
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        if (::tag.isInitialized) {
            ClientInstances.activityDestroyed(this, tag, closedByPerson = isFinishing && !isChangingConfigurations)
        }
    }

    @Deprecated("Forwarded to the client's instance and to native listeners")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        ForegroundActivities.dispatchResult(requestCode, resultCode, data)
        super.onActivityResult(requestCode, resultCode, data)
    }
}

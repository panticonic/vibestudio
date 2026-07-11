package app.vibestudio.mobile

import android.content.Intent
import android.os.Bundle
import android.util.Log
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

class MainActivity : ReactActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        clearActiveBundleForConnectIntent(intent)
        super.onCreate(savedInstanceState)
    }

    override fun onNewIntent(intent: Intent) {
        setIntent(intent)
        if (clearActiveBundleForConnectIntent(intent)) {
            restartWithIntent(intent)
            return
        }
        super.onNewIntent(intent)
    }

    /**
     * Returns the name of the main component registered from JavaScript.
     * This is used to schedule rendering of the component.
     * Must match the name used in AppRegistry.registerComponent() in index.js.
     */
    override fun getMainComponentName(): String = "Vibestudio"

    /**
     * Returns the instance of the [ReactActivityDelegate].
     * Uses [DefaultReactActivityDelegate] which handles Fabric (new architecture)
     * and concurrent rendering when enabled.
     */
    override fun createReactActivityDelegate(): ReactActivityDelegate =
        DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled)

    private fun clearActiveBundleForConnectIntent(intent: Intent?): Boolean {
        if (!isVibestudioPairingIntent(intent)) return false
        val cleared = VibestudioBundleStore.clearActive(this)
        if (cleared) {
            Log.i(TAG, "[VibestudioMobileSmoke] phase=native-connect-intent-reset")
        }
        return cleared
    }

    private fun restartWithIntent(sourceIntent: Intent) {
        val restartIntent = Intent(this, MainActivity::class.java).apply {
            action = sourceIntent.action
            data = sourceIntent.data
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        }
        startActivity(restartIntent)
        finish()
        Runtime.getRuntime().exit(0)
    }

    /**
     * A Vibestudio pairing link, in either carrier form (mirrors iOS
     * AppDelegate `VibestudioIsPairingURL`):
     *   - the custom scheme `vibestudio://connect`
     *   - the verified App Link `https://vibestudio.app/pair`
     * Both must reset the app to the native pairing bootstrap so index.js can
     * redeem the invite; only handling the scheme form left a tapped /pair App
     * Link opening the (already-loaded) workspace bundle, which has no pairing
     * listener, so nothing happened.
     */
    private fun isVibestudioPairingIntent(intent: Intent?): Boolean {
        val data = intent?.data ?: return false
        if (intent.action != Intent.ACTION_VIEW) return false
        val scheme = data.scheme?.lowercase()
        val host = data.host?.lowercase()
        if (scheme == "vibestudio" && host == "connect") return true
        if (scheme == "https" && host == "vibestudio.app" && data.path == "/pair") return true
        return false
    }

    private companion object {
        const val TAG = "VibestudioMainActivity"
    }
}

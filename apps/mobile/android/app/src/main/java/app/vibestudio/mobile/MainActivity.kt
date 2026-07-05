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
        if (!isVibestudioConnectIntent(intent)) return false
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

    private fun isVibestudioConnectIntent(intent: Intent?): Boolean {
        val data = intent?.data ?: return false
        return intent.action == Intent.ACTION_VIEW &&
            data.scheme == "vibestudio" &&
            data.host == "connect"
    }

    private companion object {
        const val TAG = "VibestudioMainActivity"
    }
}

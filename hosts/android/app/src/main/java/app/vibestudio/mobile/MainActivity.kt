package app.vibestudio.mobile

import android.content.Intent
import com.facebook.react.ReactActivity
import com.facebook.react.ReactActivityDelegate
import com.facebook.react.defaults.DefaultNewArchitectureEntryPoint.fabricEnabled
import com.facebook.react.defaults.DefaultReactActivityDelegate

/**
 * The host's own surface (pairing, review, messages). It attaches to the host
 * React instance that [MainApplication] already started; closing it does not
 * stop the host runtime. Pairing and panel links reach the host's JavaScript
 * through Linking like any other link.
 */
class MainActivity : ReactActivity() {
    /**
     * Returns the name of the main component registered from JavaScript.
     * Must match the name used in AppRegistry.registerComponent() in index.js.
     */
    override fun getMainComponentName(): String = "Vibestudio"

    override fun createReactActivityDelegate(): ReactActivityDelegate =
        object : DefaultReactActivityDelegate(this, mainComponentName, fabricEnabled) {
            /**
             * The host runtime serves every client: its timers (reconnect backoff,
             * keepalives) and connections must keep running while a client's task is
             * in front. React Native stops a context's timers when its activity pauses,
             * so the host instance stays resumed ([MainApplication]) and this screen
             * only attaches and detaches its root view.
             */
            override fun onPause() = Unit

            override fun onDestroy() {
                reactDelegate?.unloadApp()
                // Detach from the destroyed activity without leaving the resumed state.
                reactNativeHost.reactInstanceManager.onHostResume(null)
            }
        }

    @Deprecated("Forwarded to the host instance and to native listeners")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        ForegroundActivities.dispatchResult(requestCode, resultCode, data)
        super.onActivityResult(requestCode, resultCode, data)
    }
}

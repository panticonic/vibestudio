package app.vibestudio.mobile

import android.app.Application
import com.facebook.react.PackageList
import com.facebook.react.ReactApplication
import com.facebook.react.ReactNativeHost
import com.facebook.react.ReactPackage
import com.facebook.react.defaults.DefaultReactNativeHost
import com.facebook.react.soloader.OpenSourceMergedSoMapping
import com.facebook.soloader.SoLoader
import computer.iroh.IrohAndroid

/**
 * Starts the host runtime with the process: the host React Native instance
 * runs the shipped bundle headlessly from [onCreate], independent of any
 * activity. [MainActivity] attaches the host's own surface to this running
 * instance; every client runs in a separate instance of its own
 * ([ClientInstances]). Client instances are old-architecture instance
 * managers, so the new architecture must stay off.
 */
class MainApplication : Application(), ReactApplication {

    override val reactNativeHost: ReactNativeHost =
        object : DefaultReactNativeHost(this) {
            override fun getPackages(): List<ReactPackage> =
                PackageList(this).packages.apply {
                    add(VibestudioMobileHostPackage())
                    add(VibestudioHostRuntimePackage())
                    add(VibestudioConversationNotificationsPackage())
                    add(OAuthLoopbackPackage())
                    add(VibestudioIrohPackage())
                }

            override fun getJSMainModuleName(): String = "index"

            override fun getUseDeveloperSupport(): Boolean = BuildConfig.REACT_NATIVE_DEV_SUPPORT

            override val isNewArchEnabled: Boolean = false
            override val isHermesEnabled: Boolean = BuildConfig.IS_HERMES_ENABLED
        }

    override fun onCreate() {
        super.onCreate()
        check(!BuildConfig.IS_NEW_ARCHITECTURE_ENABLED) {
            "Client instances are ReactInstanceManager instances; build with newArchEnabled=false"
        }
        SoLoader.init(this, OpenSourceMergedSoMapping)
        IrohAndroid.installAndroidContext(this)
        registerActivityLifecycleCallbacks(ForegroundActivities)
        ClientInstances.init(this)
        val host = reactNativeHost.reactInstanceManager
        host.createReactContextInBackground()
        // Headless and resumed for the process's life, whichever activity is in front.
        host.onHostResume(null)
    }
}

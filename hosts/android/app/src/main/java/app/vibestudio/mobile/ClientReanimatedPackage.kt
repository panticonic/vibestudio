package app.vibestudio.mobile

import com.facebook.react.ReactInstanceManager
import com.facebook.react.bridge.ReactApplicationContext
import com.swmansion.reanimated.ReanimatedPackage

/**
 * Reanimated replaces React Native's UIManager with its own, built from the view
 * managers of "the app's" ReactInstanceManager, which it finds as the
 * Application's ReactNativeHost: the HOST's. A client instance would then get the
 * host's view managers (camera, the host's WebView stack) and none of its own
 * admitted ones. This package gives it the client's own instance instead.
 */
class ClientReanimatedPackage(private val instance: () -> ReactInstanceManager) : ReanimatedPackage() {
    override fun getReactInstanceManager(reactContext: ReactApplicationContext): ReactInstanceManager = instance()
}

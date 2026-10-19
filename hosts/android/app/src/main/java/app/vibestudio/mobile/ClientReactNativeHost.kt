package app.vibestudio.mobile

import android.app.Application
import com.facebook.react.JSEngineResolutionAlgorithm
import com.facebook.react.PackageList
import com.facebook.react.ReactNativeHost
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.JSExceptionHandler
import com.swmansion.reanimated.ReanimatedPackage

/**
 * The React Native host of one client instance: its own instance manager,
 * created from the verified bundle FILE (never the shipped asset bundle and
 * never a dev server), with only the packages [ClientPackagePolicy] admits for
 * the capabilities the client was granted, plus the broker bound to its tag.
 */
class ClientReactNativeHost(
    application: Application,
    val spec: ClientSpec,
    private val onFatal: (ClientReactNativeHost, Exception) -> Unit,
) : ReactNativeHost(application) {
    override fun getUseDeveloperSupport(): Boolean = false

    override fun getJSMainModuleName(): String = "index"

    override fun getJSBundleFile(): String = spec.bundle.bundlePath

    override fun getJSEngineResolutionAlgorithm(): JSEngineResolutionAlgorithm =
        if (BuildConfig.IS_HERMES_ENABLED) JSEngineResolutionAlgorithm.HERMES else JSEngineResolutionAlgorithm.JSC

    override fun getJSExceptionHandler(): JSExceptionHandler = object : JSExceptionHandler {
        override fun handleException(e: Exception) = onFatal(this@ClientReactNativeHost, e)
    }

    override fun getPackages(): List<ReactPackage> {
        // Fresh package objects per instance: PackageList builds new ones on every call.
        val candidates = PackageList(application).packages.map { candidate ->
            if (candidate is ReanimatedPackage) ClientReanimatedPackage { reactInstanceManager } else candidate
        } + listOf(WorkspaceWebViewPackage(), VibestudioPanelHostPackage(), OAuthLoopbackPackage())
        return ClientPackagePolicy.filter(candidates, spec.grantedCapabilities) +
            VibestudioClientBrokerPackage(spec.tag, spec.clientId)
    }
}

/** Bound to a ClientActivity that is waiting for the host runtime to start its client; it never creates an instance. */
class IdleReactNativeHost(application: Application) : ReactNativeHost(application) {
    override fun getUseDeveloperSupport(): Boolean = false
    override fun getPackages(): List<ReactPackage> = emptyList()
}

package app.vibestudio.mobile

/**
 * Which autolinked and app-owned React packages a client instance may register.
 *
 * Fail closed: a package is admitted only when it is named here. A newly
 * autolinked library therefore stays out of every client until someone
 * decides which class it belongs to, instead of silently handing a client a
 * raw device module (keychain, push, notifications, storage, iroh, the host
 * runtime...). Host-only modules (VibestudioMobileHost, VibestudioHostRuntime,
 * VibestudioIroh, react-native-keychain, react-native-firebase, notifee,
 * async-storage, clipboard, vision-camera) are simply never listed.
 */
object ClientPackagePolicy {
    const val PANEL_HOSTING = "panel-hosting"

    /** UI-class natives every client may use. */
    private val UI_PACKAGES = setOf(
        "com.facebook.react.shell.MainReactPackage",
        "com.swmansion.gesturehandler.RNGestureHandlerPackage",
        "com.swmansion.reanimated.ReanimatedPackage",
        "com.swmansion.rnscreens.RNScreensPackage",
        "com.th3rdwave.safeareacontext.SafeAreaContextPackage",
        "com.horcrux.svg.SvgPackage",
        "com.mkuczera.RNReactNativeHapticFeedbackPackage",
        "com.reactnativecommunity.netinfo.NetInfoPackage",
        "org.linusu.RNGetRandomValuesPackage",
        "app.vibestudio.mobile.OAuthLoopbackPackage",
    )

    /** The WebView stack a browser needs; admitted only with the `panel-hosting` capability. */
    private val PANEL_HOSTING_PACKAGES = setOf(
        "com.reactnativecommunity.webview.RNCWebViewPackage",
        "com.asterinet.react.tcpsocket.TcpSocketPackage",
        "app.vibestudio.mobile.WorkspaceWebViewPackage",
        "app.vibestudio.mobile.VibestudioPanelHostPackage",
    )

    fun admits(packageClassName: String, grantedCapabilities: Collection<String>): Boolean =
        packageClassName in UI_PACKAGES ||
            (packageClassName in PANEL_HOSTING_PACKAGES && PANEL_HOSTING in grantedCapabilities)

    fun <T : Any> filter(
        packages: List<T>,
        grantedCapabilities: Collection<String>,
    ): List<T> = packages.filter { admits(it.javaClass.name, grantedCapabilities) }
}

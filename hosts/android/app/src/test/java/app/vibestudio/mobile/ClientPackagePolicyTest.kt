package app.vibestudio.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ClientPackagePolicyTest {
    private val rawDevicePackages = listOf(
        "com.oblador.keychain.KeychainPackage",
        "io.invertase.firebase.app.ReactNativeFirebaseAppPackage",
        "io.invertase.firebase.messaging.ReactNativeFirebaseMessagingPackage",
        "io.invertase.notifee.NotifeePackage",
        "com.reactnativecommunity.asyncstorage.AsyncStoragePackage",
        "com.reactnativecommunity.clipboard.ClipboardPackage",
        "com.mrousavy.camera.react.CameraPackage",
        // Stock Reanimated would build a client's UIManager from the host's view managers.
        "com.swmansion.reanimated.ReanimatedPackage",
        "app.vibestudio.mobile.VibestudioIrohPackage",
        "app.vibestudio.mobile.VibestudioMobileHostPackage",
        "app.vibestudio.mobile.VibestudioHostRuntimePackage",
    )
    private val uiPackages = listOf(
        "com.facebook.react.shell.MainReactPackage",
        "com.swmansion.gesturehandler.RNGestureHandlerPackage",
        "app.vibestudio.mobile.ClientReanimatedPackage",
        "com.swmansion.rnscreens.RNScreensPackage",
        "com.th3rdwave.safeareacontext.SafeAreaContextPackage",
        "com.horcrux.svg.SvgPackage",
        "com.mkuczera.RNReactNativeHapticFeedbackPackage",
        "com.reactnativecommunity.netinfo.NetInfoPackage",
        "app.vibestudio.mobile.OAuthLoopbackPackage",
    )
    private val panelPackages = listOf(
        "com.reactnativecommunity.webview.RNCWebViewPackage",
        "com.asterinet.react.tcpsocket.TcpSocketPackage",
        "app.vibestudio.mobile.WorkspaceWebViewPackage",
        "app.vibestudio.mobile.VibestudioPanelHostPackage",
    )

    @Test fun rawDevicePackagesNeverReachAClient() {
        for (name in rawDevicePackages) {
            assertFalse(name, ClientPackagePolicy.admits(name, emptyList()))
            assertFalse(name, ClientPackagePolicy.admits(name, listOf("panel-hosting", "anything")))
        }
    }

    @Test fun uiPackagesAlwaysStay() {
        for (name in uiPackages) assertTrue(name, ClientPackagePolicy.admits(name, emptyList()))
    }

    @Test fun panelPackagesNeedPanelHosting() {
        for (name in panelPackages) {
            assertFalse(name, ClientPackagePolicy.admits(name, emptyList()))
            assertFalse(name, ClientPackagePolicy.admits(name, listOf("notifications")))
            assertTrue(name, ClientPackagePolicy.admits(name, listOf("panel-hosting")))
        }
    }

    @Test fun unknownPackagesAreRefused() {
        assertFalse(ClientPackagePolicy.admits("com.example.NewDeviceModulePackage", listOf("panel-hosting")))
    }

    @Test fun filterKeepsOrderOfAdmittedInstances() {
        class A
        val kept = ClientPackagePolicy.filter(listOf(A(), A()), emptyList())
        assertEquals(0, kept.size)
    }
}

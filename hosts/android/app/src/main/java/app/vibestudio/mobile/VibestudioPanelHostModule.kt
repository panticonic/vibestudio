package app.vibestudio.mobile

import android.os.Handler
import android.os.Looper
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import java.util.concurrent.ConcurrentHashMap

/**
 * Panel-hosting natives of a client instance: the durable immutable-asset
 * store and workspace-cookie clearing. Registered only in a client instance
 * that was granted `panel-hosting` (see [ClientPackagePolicy]); the host
 * instance and every other client never see it.
 */
class VibestudioPanelHostModule(
    reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {
    private val store = PanelAssetStore.get(reactContext)
    private val ownedWrites = ConcurrentHashMap.newKeySet<String>()

    override fun getName(): String = "VibestudioPanelHost"

    @ReactMethod
    fun clearWorkspaceCookies(scope: String, promise: Promise) {
        Handler(Looper.getMainLooper()).post {
            try {
                require(scope.isNotBlank()) { "A workspace browser profile is required" }
                check(androidx.webkit.WebViewFeature.isFeatureSupported(androidx.webkit.WebViewFeature.MULTI_PROFILE)) {
                    "Update Android System WebView to manage workspace cookies"
                }
                val profile = androidx.webkit.ProfileStore.getInstance().getProfile(WorkspaceWebViewManager.profileName(scope))
                if (profile == null) {
                    promise.resolve(null)
                } else {
                    val cookies = profile.cookieManager
                    cookies.removeAllCookies {
                        cookies.flush()
                        promise.resolve(null)
                    }
                }
            } catch (error: Exception) {
                promise.reject("workspace_cookie_clear_failed", error.message, error)
            }
        }
    }

    @ReactMethod
    fun assetStoreLookup(namespace: ReadableMap, key: String, promise: Promise) {
        try {
            promise.resolve(store.lookup(namespace, key))
        } catch (error: Exception) {
            promise.reject("asset_store_lookup_failed", error.message, error)
        }
    }

    @ReactMethod
    fun assetStoreOpenWrite(namespace: ReadableMap, key: String, promise: Promise) {
        try {
            val writeId = store.openWrite(namespace, key)
            ownedWrites.add(writeId)
            promise.resolve(writeId)
        } catch (error: Exception) {
            promise.reject("asset_store_open_failed", error.message, error)
        }
    }

    @ReactMethod
    fun assetStoreAppend(writeId: String, bytesBase64: String, promise: Promise) {
        try {
            store.append(writeId, bytesBase64)
            promise.resolve(null)
        } catch (error: Exception) {
            ownedWrites.remove(writeId)
            promise.reject("asset_store_append_failed", error.message, error)
        }
    }

    @ReactMethod
    fun assetStoreCommit(writeId: String, metadataJson: String, promise: Promise) {
        ownedWrites.remove(writeId)
        try {
            promise.resolve(store.commit(writeId, metadataJson))
        } catch (error: Exception) {
            promise.reject("asset_store_commit_failed", error.message, error)
        }
    }

    @ReactMethod
    fun assetStoreAbort(writeId: String, promise: Promise) {
        ownedWrites.remove(writeId)
        store.abort(writeId)
        promise.resolve(null)
    }

    @ReactMethod
    fun assetStoreTrim(maxBytes: Double, promise: Promise) {
        try {
            store.trim(maxBytes)
            promise.resolve(null)
        } catch (error: Exception) {
            promise.reject("asset_store_trim_failed", error.message, error)
        }
    }

    @ReactMethod
    fun assetStoreClear(promise: Promise) {
        try {
            store.clear()
            ownedWrites.clear()
            promise.resolve(null)
        } catch (error: Exception) {
            promise.reject("asset_store_clear_failed", error.message, error)
        }
    }

    override fun invalidate() {
        // Writes this instance opened and never finished die with it; another
        // instance's in-flight writes are not ours to abort.
        for (writeId in ownedWrites.toList()) store.abort(writeId)
        ownedWrites.clear()
        super.invalidate()
    }
}

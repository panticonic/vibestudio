package app.vibestudio.mobile

import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.Log
import com.facebook.react.ReactApplication
import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import java.io.File
import java.security.MessageDigest

class VibestudioMobileHostModule(
    reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {
    private var bundleStream: java.io.FileOutputStream? = null
    private var bundleTransferFile: File? = null
    private var bundleFinalFile: File? = null

    override fun getName(): String = "VibestudioMobileHost"

    override fun getConstants(): MutableMap<String, Any> = hashMapOf(
        "firebaseConfigured" to BuildConfig.VIBESTUDIO_HAS_FIREBASE
    )

    @ReactMethod
    fun resetToNativeBootstrap(promise: Promise) {
        try {
            closeBundleStream()
            VibestudioBundleStore.clearActive(reactApplicationContext)
            promise.resolve(Arguments.createMap().apply {
                putBoolean("reloading", true)
            })
            Handler(Looper.getMainLooper()).post {
                try {
                    Log.i(TAG, "[VibestudioMobileSmoke] phase=native-bootstrap-reset")
                    reloadReactNative()
                } catch (error: Exception) {
                    Log.e(TAG, "Failed to reload React Native after bootstrap reset", error)
                }
            }
        } catch (error: Exception) {
            promise.reject("bootstrap_reset_failed", error.message, error)
        }
    }

    @ReactMethod
    fun appendBundleChunk(
        bytesBase64: String,
        buildKey: String,
        artifactPath: String,
        reset: Boolean,
        promise: Promise,
    ) {
        try {
            if (reset) {
                closeBundleStream()
                val safeBuildKey = safePathSegment(buildKey)
                val safeArtifact = safePathSegment(artifactPath)
                val dir = File(reactApplicationContext.cacheDir, "vibestudio-rn/$safeBuildKey")
                dir.mkdirs()
                bundleFinalFile = File(dir, safeArtifact)
                bundleTransferFile = File(dir, "$safeArtifact.transfer")
                bundleStream = java.io.FileOutputStream(bundleTransferFile, false)
            }
            val stream = bundleStream
                ?: throw IllegalStateException("appendBundleChunk called before reset")
            stream.write(Base64.decode(bytesBase64, Base64.DEFAULT))
            promise.resolve(null)
        } catch (error: Exception) {
            closeBundleStream()
            promise.reject("bundle_append_failed", error.message, error)
        }
    }

    @ReactMethod
    fun finalizeBundleWrite(integrity: String, gzip: Boolean, promise: Promise) {
        try {
            val stream = bundleStream
                ?: throw IllegalStateException("finalizeBundleWrite called before any chunk")
            stream.flush()
            stream.close()
            bundleStream = null
            val transferFile = bundleTransferFile
                ?: throw IllegalStateException("missing transfer file")
            val finalFile = bundleFinalFile
                ?: throw IllegalStateException("missing bundle file")
            bundleTransferFile = null
            bundleFinalFile = null

            val digest = MessageDigest.getInstance("SHA-256")
            val input: java.io.InputStream =
                if (gzip) java.util.zip.GZIPInputStream(java.io.FileInputStream(transferFile))
                else java.io.FileInputStream(transferFile)
            input.use { inp ->
                java.io.FileOutputStream(finalFile).use { out ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        val n = inp.read(buf)
                        if (n < 0) break
                        out.write(buf, 0, n)
                        digest.update(buf, 0, n)
                    }
                }
            }
            transferFile.delete()
            val expected = integrity.removePrefix("sha256-")
            val actual = digest.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) }
            if (
                expected.length != 64 ||
                expected.any { it !in '0'..'9' && it !in 'a'..'f' && it !in 'A'..'F' } ||
                !actual.equals(expected, ignoreCase = true)
            ) {
                throw IllegalStateException("React Native bundle integrity mismatch")
            }
            Log.i(TAG, "[VibestudioMobileSmoke] phase=native-bundle-prepared-from-bytes")
            promise.resolve(Arguments.createMap().apply {
                putString("localPath", finalFile.absolutePath)
            })
        } catch (error: Exception) {
            closeBundleStream()
            promise.reject("bundle_finalize_failed", error.message, error)
        }
    }

    @ReactMethod
    fun activatePreparedAppBundle(localPath: String, buildKey: String, integrity: String, promise: Promise) {
        try {
            val changed = VibestudioBundleStore.activate(reactApplicationContext, localPath, buildKey, integrity)
            Log.i(TAG, "[VibestudioMobileSmoke] phase=native-bundle-activated changed=$changed")
            promise.resolve(Arguments.createMap().apply {
                putBoolean("activated", changed)
            })
            if (changed) {
                Handler(Looper.getMainLooper()).post {
                    try {
                        Log.i(TAG, "[VibestudioMobileSmoke] phase=native-rn-reload-requested")
                        reloadReactNative()
                    } catch (error: Exception) {
                        Log.e(TAG, "Failed to reload React Native after bundle activation", error)
                    }
                }
            }
        } catch (error: Exception) {
            promise.reject("bundle_activate_failed", error.message, error)
        }
    }

    private fun closeBundleStream() {
        bundleStream?.runCatching { close() }
        bundleStream = null
    }

    private fun reloadReactNative() {
        val app = reactApplicationContext.applicationContext as? ReactApplication
            ?: throw IllegalStateException("Application is not a ReactApplication")
        if (BuildConfig.IS_NEW_ARCHITECTURE_ENABLED) {
            (app.reactHost ?: throw IllegalStateException("ReactHost is unavailable"))
                .reload("Vibestudio workspace app bundle activated")
        } else {
            restartApplicationProcess()
        }
    }

    private fun restartApplicationProcess() {
        val launchIntent = reactApplicationContext.packageManager
            .getLaunchIntentForPackage(reactApplicationContext.packageName)
            ?: throw IllegalStateException("Could not resolve mobile launch intent")
        launchIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        reactApplicationContext.startActivity(launchIntent)
        Runtime.getRuntime().exit(0)
    }

    private fun safePathSegment(value: String): String =
        value.replace(Regex("[^A-Za-z0-9._-]"), "_").ifBlank { "bundle" }

    private companion object {
        const val TAG = "VibestudioMobileHost"
    }
}

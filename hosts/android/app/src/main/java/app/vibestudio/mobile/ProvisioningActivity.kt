package app.vibestudio.mobile

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.util.Base64
import java.security.MessageDigest

/**
 * USB provisioning entry point.
 *
 * This activity is protected by android.permission.DUMP, which the Android
 * shell used by adb holds and ordinary applications do not. It converts the
 * desktop's already-authorized provisioning action into a one-use approval
 * consumed by the React Native bootstrap. Browser/QR links still require an
 * explicit tap in MainActivity.
 */
class ProvisioningActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val pairUrl = intent?.data?.toString()
        if (pairUrl.isNullOrBlank()) {
            finish()
            return
        }

        val approvalDigest = pairingApprovalDigest(pairUrl)
        if (approvalDigest == null) {
            finish()
            return
        }

        getSharedPreferences(PREFERENCES, MODE_PRIVATE)
            .edit()
            .putString(PAIR_URL_DIGEST, approvalDigest)
            .putLong(APPROVED_AT, System.currentTimeMillis())
            // MainActivity may immediately terminate this process to unload an
            // active workspace bundle. The one-use trust receipt must reach
            // disk before that restart or the new bootstrap falls back to the
            // interactive Pair screen.
            .commit()

        startActivity(Intent(this, MainActivity::class.java).apply {
            action = Intent.ACTION_VIEW
            data = intent.data
            // MainActivity is singleTask. Reuse its native-bootstrap React root
            // so overlapping desktop retries are coalesced by the one active
            // pairing flow instead of destroying that flow and creating a
            // second bundle transfer. MainActivity still performs a full reset
            // itself when a workspace bundle is currently active.
            addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        })
        finish()
    }

    companion object {
        const val PREFERENCES = "vibestudio-usb-provisioning"
        const val PAIR_URL_DIGEST = "pair-url-digest"
        const val APPROVED_AT = "approved-at"

        /**
         * Bind USB approval to the semantic pairing payload, not Android's raw
         * carrier spelling. A URL delivered through onNewIntent and the same URL
         * restored after the workspace bundle reset can differ only in percent
         * encoding; hashing the raw strings incorrectly turned that native
         * lifecycle transition into an interactive Pair prompt.
         */
        fun pairingApprovalDigest(pairUrl: String): String? {
            val uri = runCatching { Uri.parse(pairUrl) }.getOrNull() ?: return null
            val compactPayload = when {
                uri.scheme?.lowercase() == "vibestudio" &&
                    uri.host?.lowercase() == "connect" &&
                    uri.query == null &&
                    uri.fragment == null &&
                    uri.pathSegments.size == 1 -> uri.pathSegments.single()
                uri.scheme?.lowercase() == "https" &&
                    uri.host?.lowercase() == "vibestudio.app" &&
                    uri.path == "/p" &&
                    uri.query == null -> uri.fragment
                else -> null
            } ?: return null
            // The compact payload is the canonical pairing material shared by
            // the app and host. Keep native USB approval carrier-independent:
            // the same payload may arrive as vibestudio://connect/<payload> or
            // https://vibestudio.app/p#<payload>. The JS parser remains the
            // single authority for decoding and validating its binary grammar.
            if (!COMPACT_PAYLOAD.matches(compactPayload)) return null
            return Base64.encodeToString(
                MessageDigest.getInstance("SHA-256")
                    .digest(compactPayload.toByteArray(Charsets.US_ASCII)),
                Base64.NO_WRAP,
            )
        }

        private val COMPACT_PAYLOAD = Regex("^[A-Za-z0-9_-]+$")
    }
}

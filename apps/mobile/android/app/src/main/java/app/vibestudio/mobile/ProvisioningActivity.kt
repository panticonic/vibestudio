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
            if (uri.scheme?.lowercase() != "vibestudio" || uri.host?.lowercase() != "connect") {
                return null
            }
            val names = listOf("room", "fp", "code", "sig", "v", "ice")
            val values = names.map { name -> uri.getQueryParameter(name) ?: return null }
            val material = values.joinToString(separator = "") { value -> "${value.length}:$value" }
            return Base64.encodeToString(
                MessageDigest.getInstance("SHA-256").digest(material.toByteArray(Charsets.UTF_8)),
                Base64.NO_WRAP,
            )
        }
    }
}

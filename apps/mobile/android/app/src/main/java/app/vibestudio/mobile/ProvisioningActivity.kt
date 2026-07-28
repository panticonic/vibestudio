package app.vibestudio.mobile

import android.app.Activity
import android.content.Intent
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

        getSharedPreferences(PREFERENCES, MODE_PRIVATE)
            .edit()
            .putString(PAIR_URL_DIGEST, digest(pairUrl))
            .putLong(APPROVED_AT, System.currentTimeMillis())
            .apply()

        startActivity(Intent(this, MainActivity::class.java).apply {
            action = Intent.ACTION_VIEW
            data = intent.data
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        })
        finish()
    }

    private fun digest(value: String): String =
        Base64.encodeToString(
            MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8)),
            Base64.NO_WRAP,
        )

    companion object {
        const val PREFERENCES = "vibestudio-usb-provisioning"
        const val PAIR_URL_DIGEST = "pair-url-digest"
        const val APPROVED_AT = "approved-at"
    }
}

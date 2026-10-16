package app.vibestudio.mobile

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import org.json.JSONObject

/**
 * The launcher half of the launch surfaces: the long-press menu (dynamic
 * shortcuts), pinned shortcuts and their retirement. Every shortcut opens a
 * `vibestudio://c/<id>/<intent>` link in [IngressActivity], which hands it to
 * the host runtime; no shortcut names a client's code.
 */
object LaunchShortcuts {
    private fun shortcut(context: Context, id: String, shortLabel: String, longLabel: String, link: String) =
        ShortcutInfoCompat.Builder(context, id)
            .setShortLabel(shortLabel)
            .setLongLabel(longLabel)
            .setIcon(IconCompat.createWithResource(context, R.mipmap.ic_launcher))
            .setIntent(linkIntent(context, link))
            .build()

    fun linkIntent(context: Context, link: String): Intent =
        Intent(Intent.ACTION_VIEW, Uri.parse(link)).setClass(context, IngressActivity::class.java)

    /** Replace the launcher's long-press menu with the published surfaces. */
    fun publishDynamic(context: Context, surfaces: LaunchSurfaces) {
        val max = ShortcutManagerCompat.getMaxShortcutCountPerActivity(context)
        val specs = DynamicShortcutPlan.plan(surfaces, max)
        ShortcutManagerCompat.setDynamicShortcuts(
            context,
            specs.map { shortcut(context, it.id, it.shortLabel, it.longLabel, it.link) },
        )
    }

    /**
     * Ask the launcher to pin a shortcut. The person confirms in the launcher's
     * own UI; when they agree the launcher fires [PinResultReceiver], the only
     * signal that they did. Returns false when the launcher cannot pin.
     */
    fun requestPin(context: Context, id: String, label: String, link: String): Boolean {
        if (!ShortcutManagerCompat.isRequestPinShortcutSupported(context)) return false
        val confirmed = PendingIntent.getBroadcast(
            context,
            id.hashCode(),
            Intent(context, PinResultReceiver::class.java)
                .putExtra(PinResultReceiver.EXTRA_ID, id)
                .putExtra(PinResultReceiver.EXTRA_LABEL, label)
                .putExtra(PinResultReceiver.EXTRA_LINK, link),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        return ShortcutManagerCompat.requestPinShortcut(
            context,
            shortcut(context, id, label, label, link),
            confirmed.intentSender,
        )
    }

    /**
     * A pinned shortcut cannot be deleted by its app; disabling it makes the
     * launcher say `message` when the person taps it.
     */
    fun disable(context: Context, ids: List<String>, message: String) {
        if (ids.isEmpty()) return
        ShortcutManagerCompat.disableShortcuts(context, ids, message)
    }
}

/** The launcher confirmed a pinned shortcut the host asked for. */
class PinResultReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val id = intent.getStringExtra(EXTRA_ID) ?: return
        val label = intent.getStringExtra(EXTRA_LABEL) ?: return
        val link = intent.getStringExtra(EXTRA_LINK) ?: return
        HostIngress.forward(
            JSONObject().put("type", "shortcut-pinned").put("shortcutId", id).put("label", label).put("link", link),
        )
    }

    companion object {
        const val EXTRA_ID = "app.vibestudio.mobile.pin.id"
        const val EXTRA_LABEL = "app.vibestudio.mobile.pin.label"
        const val EXTRA_LINK = "app.vibestudio.mobile.pin.link"
    }
}

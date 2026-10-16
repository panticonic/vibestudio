package app.vibestudio.mobile

import android.content.Context

/**
 * The last published [LaunchSurfaces], kept on the device so the widget can
 * draw without the host runtime (a widget update can arrive before the host's
 * JavaScript has run in a fresh process).
 */
object LaunchSurfacesStore {
    private const val PREFS = "vibestudio-launch-surfaces"
    private const val KEY = "surfaces"

    /** Stores the published JSON as the host runtime sent it (it parses, or this throws). */
    fun save(context: Context, json: String): LaunchSurfaces {
        val surfaces = LaunchSurfaces.parse(json)
        check(context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY, json).commit()) {
            "Could not store the launch surfaces"
        }
        return surfaces
    }

    fun load(context: Context): LaunchSurfaces {
        val json = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY, null) ?: return LaunchSurfaces.EMPTY
        return LaunchSurfaces.parse(json)
    }
}

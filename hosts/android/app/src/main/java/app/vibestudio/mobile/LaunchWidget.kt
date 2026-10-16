package app.vibestudio.mobile

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.view.View
import android.widget.RemoteViews

/**
 * Home-screen widget listing a client's dynamic entries (recent conversations),
 * or its plain launchers when it has none, from the last published
 * [LaunchSurfaces]. A tap opens the entry's link through [IngressActivity]; the
 * Ask button opens the Ask prompt. It redraws when the host publishes new
 * surfaces, never on a timer (`updatePeriodMillis` is 0).
 */
class LaunchWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, appWidgetIds: IntArray) =
        update(context, manager, appWidgetIds)

    companion object {
        private val ENTRY_IDS = intArrayOf(
            R.id.widget_entry_0,
            R.id.widget_entry_1,
            R.id.widget_entry_2,
            R.id.widget_entry_3,
            R.id.widget_entry_4,
        )

        /** Redraw every placed instance from the stored surfaces. */
        fun refreshAll(context: Context) {
            val manager = AppWidgetManager.getInstance(context)
            update(context, manager, manager.getAppWidgetIds(ComponentName(context, LaunchWidgetProvider::class.java)))
        }

        private fun update(context: Context, manager: AppWidgetManager, ids: IntArray) {
            if (ids.isEmpty()) return
            val content = WidgetContent.of(LaunchSurfacesStore.load(context), ENTRY_IDS.size)
            for (id in ids) manager.updateAppWidget(id, views(context, content))
        }

        private fun views(context: Context, content: WidgetContent): RemoteViews {
            val views = RemoteViews(context.packageName, R.layout.widget_launch)
            views.setTextViewText(R.id.widget_title, content.title)
            if (content.canAsk) {
                views.setViewVisibility(R.id.widget_ask, View.VISIBLE)
                views.setOnClickPendingIntent(
                    R.id.widget_ask,
                    PendingIntent.getActivity(
                        context,
                        0,
                        Intent(context, AskActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
                        PendingIntent.FLAG_IMMUTABLE,
                    ),
                )
            } else {
                views.setViewVisibility(R.id.widget_ask, View.GONE)
            }
            ENTRY_IDS.forEachIndexed { index, viewId ->
                val entry = content.entries.getOrNull(index)
                if (entry == null) {
                    views.setViewVisibility(viewId, if (index == 0) View.VISIBLE else View.GONE)
                    if (index == 0) views.setTextViewText(viewId, context.getString(R.string.widget_empty))
                } else {
                    views.setViewVisibility(viewId, View.VISIBLE)
                    views.setTextViewText(viewId, entry.label)
                    views.setOnClickPendingIntent(
                        viewId,
                        PendingIntent.getActivity(
                            context,
                            entry.link.hashCode(),
                            LaunchShortcuts.linkIntent(context, entry.link),
                            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
                        ),
                    )
                }
            }
            return views
        }
    }
}

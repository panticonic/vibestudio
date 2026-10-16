package app.vibestudio.mobile

import org.json.JSONArray
import org.json.JSONObject

/**
 * The launch surfaces the host runtime publishes (`LaunchSurfaces` in
 * hosts/react-native/src/host/integration.ts): what each client can launch
 * without further input, and the background intents that take free text. The
 * host runtime decides all of it from the clients' declarations; native only
 * stores and renders it. Pure so it is unit tested without Android.
 */
data class LaunchItem(val intent: String, val label: String, val link: String)

data class ClientSurfaces(
    val clientId: String,
    val title: String,
    /** Plain foreground intents, `open` first. */
    val shortcuts: List<LaunchItem>,
    /** Dynamic entries of parameterized intents (recent conversations). */
    val recent: List<LaunchItem>,
)

data class LaunchSurfaces(
    val clients: List<ClientSurfaces>,
    /** Whether some client declares a free-text background intent (the Ask widget button and tile need one). */
    val canAsk: Boolean,
) {
    companion object {
        val EMPTY = LaunchSurfaces(emptyList(), canAsk = false)

        /** Reads the host runtime's published JSON; what only iOS uses (`shareIn`) is ignored. */
        fun parse(json: String): LaunchSurfaces {
            val root = JSONObject(json)
            val clients = root.getJSONArray("clients").objects().map { client ->
                ClientSurfaces(
                    clientId = client.getString("clientId"),
                    title = client.getString("title"),
                    shortcuts = parseItems(client.getJSONArray("shortcuts")),
                    recent = parseItems(client.getJSONArray("recent")),
                )
            }
            val background = root.optJSONArray("background")
            return LaunchSurfaces(clients, canAsk = background != null && background.length() > 0)
        }

        private fun parseItems(array: JSONArray) = array.objects().map {
            LaunchItem(it.getString("intent"), it.getString("label"), it.getString("link"))
        }

        private fun JSONArray.objects(): List<JSONObject> = (0 until length()).map { getJSONObject(it) }
    }
}

/** A dynamic shortcut as the launcher's long-press menu shows it. */
data class ShortcutSpec(val id: String, val shortLabel: String, val longLabel: String, val link: String)

/**
 * Which launch items become dynamic shortcuts when the launcher shows only
 * `max` of them. Levels, most prominent first: every client's `open`, then
 * the rest of each client's plain shortcuts, then dynamic entries, each level
 * taken client by client in order so one client with many entries cannot push
 * the others out. A shortcut's id is its link, so a pinned copy of the same
 * item is updated rather than duplicated.
 */
object DynamicShortcutPlan {
    fun plan(surfaces: LaunchSurfaces, max: Int): List<ShortcutSpec> {
        if (max <= 0) return emptyList()
        val levels = listOf(
            surfaces.clients.mapNotNull { client -> client.shortcuts.firstOrNull { it.intent == OPEN }?.let { client to it } },
            surfaces.clients.flatMap { client -> client.shortcuts.filter { it.intent != OPEN }.map { client to it } },
            surfaces.clients.flatMap { client -> client.recent.map { client to it } },
        )
        return levels.asSequence()
            .flatMap { it.asSequence() }
            .map { (client, item) ->
                ShortcutSpec(
                    id = item.link,
                    shortLabel = item.label,
                    longLabel = if (item.intent == OPEN) item.label else "${client.title}: ${item.label}",
                    link = item.link,
                )
            }
            .distinctBy { it.id }
            .take(max)
            .toList()
    }

    private const val OPEN = "open"
}

/** What the home-screen widget lists: one client's entries, with a title. */
data class WidgetContent(val title: String, val entries: List<LaunchItem>, val canAsk: Boolean) {
    companion object {
        val EMPTY = WidgetContent("Vibestudio", emptyList(), canAsk = false)

        /**
         * The first client with dynamic entries (recent conversations), else the
         * first client's plain shortcuts. At most `max` entries.
         */
        fun of(surfaces: LaunchSurfaces, max: Int): WidgetContent {
            val client = surfaces.clients.firstOrNull { it.recent.isNotEmpty() } ?: surfaces.clients.firstOrNull()
                ?: return EMPTY.copy(canAsk = surfaces.canAsk)
            val entries = if (client.recent.isNotEmpty()) client.recent else client.shortcuts
            return WidgetContent(client.title, entries.take(max), surfaces.canAsk)
        }
    }
}

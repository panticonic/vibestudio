package app.vibestudio.mobile

import org.json.JSONArray
import org.json.JSONObject

/** The client intent that shows a conversation, resolved by the host runtime. */
data class ConversationTarget(val link: String, val tag: String, val clientId: String, val title: String)

data class ReplyAction(val id: String, val title: String)

/**
 * A pushed inbox entry the host runtime asks native to draw
 * (`InboxNotification` in hosts/react-native/src/host/notifications/hostNotifications.ts).
 * Pure parsing and decisions, so they are unit tested without Android.
 */
data class ConversationSpec(
    val id: String,
    val title: String,
    val body: String,
    val high: Boolean,
    val actions: List<ReplyAction>,
    /** The push's data payload as the host runtime attached it; handed back with every event. */
    val dataJson: String,
    val conversation: ConversationTarget?,
) {
    /** Who the message is from: the push's `senderHandle`, otherwise the title. */
    val sender: String
        get() = JSONObject(dataJson).optString("senderHandle", "").ifBlank { title }

    /** A conversation notification is a bubble only where the OS has bubbles (Android 11) and a client can show it. */
    fun bubbleEligible(sdkInt: Int): Boolean = sdkInt >= BUBBLES_SDK && conversation != null

    /** One long-lived shortcut per conversation: what MessagingStyle, bubbles and direct share key on. */
    val shortcutId: String?
        get() = conversation?.let { "conversation:${it.link}" }

    companion object {
        const val BUBBLES_SDK = 30

        fun parse(json: String): ConversationSpec {
            val root = JSONObject(json)
            val conversation = root.optJSONObject("conversation")?.let {
                ConversationTarget(
                    link = it.getString("link"),
                    tag = it.getString("tag"),
                    clientId = it.getString("clientId"),
                    title = it.getString("title"),
                )
            }
            return ConversationSpec(
                id = root.getString("id"),
                title = root.getString("title"),
                body = root.getString("body"),
                high = root.getString("priority") == "high",
                actions = root.getJSONArray("actions").objects().map {
                    ReplyAction(it.getString("id"), it.getString("title"))
                },
                dataJson = root.getString("dataJson"),
                conversation = conversation,
            )
        }

        private fun JSONArray.objects(): List<JSONObject> = (0 until length()).map { getJSONObject(it) }

        /** The host-runtime event for a press or a typed reply on a notification native drew. */
        fun event(kind: String, actionId: String?, input: String?, dataJson: String): JSONObject =
            JSONObject()
                .put("type", "notification-event")
                .put("kind", kind)
                .also { event ->
                    if (actionId != null) event.put("actionId", actionId)
                    if (input != null) event.put("input", input)
                }
                .put("data", JSONObject(dataJson))
    }
}

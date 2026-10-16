package app.vibestudio.mobile

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.app.Person
import androidx.core.app.RemoteInput
import androidx.core.content.LocusIdCompat
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.ReadableMap
import org.json.JSONObject

/**
 * Pushed inbox entries drawn as conversation notifications
 * (docs/client-hosts-and-clients-plan.md 4.7.3, 5.3): MessagingStyle with a
 * long-lived conversation shortcut, a `RemoteInput` reply field and, on
 * Android 11+, a bubble that shows the client of the conversation. Notifee
 * cannot express bubbles, so the host runtime draws inbox entries here on
 * Android and through notifee on iOS; what the person does comes back to the
 * same JavaScript handler either way.
 */
object ConversationNotifier {
    const val CHANNEL_ID = "conversations"
    private const val CATEGORY = "app.vibestudio.mobile.category.CONVERSATION"
    private const val REPLY_KEY = "reply"

    fun post(context: Context, spec: ConversationSpec) {
        ensureChannel(context)
        val manager = NotificationManagerCompat.from(context)
        val sender = Person.Builder().setName(spec.sender).setKey("sender:${spec.sender}").build()
        val me = Person.Builder().setName("You").setKey("self").build()
        val shortcutId = spec.shortcutId?.also { publishConversationShortcut(context, it, spec, sender) }

        val builder = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_ask_tile)
            .setContentTitle(spec.title)
            .setContentText(spec.body)
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(if (spec.high) NotificationCompat.PRIORITY_HIGH else NotificationCompat.PRIORITY_DEFAULT)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setStyle(
                NotificationCompat.MessagingStyle(me)
                    .setConversationTitle(spec.conversation?.title)
                    .addMessage(spec.body, System.currentTimeMillis(), sender),
            )
            .setContentIntent(contentIntent(context, spec))
        if (shortcutId != null) builder.setShortcutId(shortcutId).setLocusId(LocusIdCompat(shortcutId))
        for (action in spec.actions) builder.addAction(replyAction(context, spec, action))
        if (spec.bubbleEligible(Build.VERSION.SDK_INT)) bubble(context, spec)?.let { builder.setBubbleMetadata(it) }
        manager.notify(spec.id, 0, builder.build())
    }

    fun cancel(context: Context, id: String) {
        NotificationManagerCompat.from(context).cancel(id, 0)
    }

    /** The conversations channel; bubbles can only be allowed on the channel when it is created. */
    private fun ensureChannel(context: Context) {
        if (Build.VERSION.SDK_INT < 26) return
        val system = context.getSystemService(NotificationManager::class.java)
        if (system.getNotificationChannel(CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            context.getString(R.string.conversations_channel_name),
            NotificationManager.IMPORTANCE_HIGH,
        )
        if (Build.VERSION.SDK_INT >= 29) channel.setAllowBubbles(true)
        system.createNotificationChannel(channel)
    }

    /** A press opens the conversation in its client; an entry no client can show opens the host. */
    private fun contentIntent(context: Context, spec: ConversationSpec): PendingIntent {
        val intent = spec.conversation?.let { LaunchShortcuts.linkIntent(context, it.link) }
            ?: Intent(context, MainActivity::class.java)
        return PendingIntent.getActivity(
            context,
            spec.id.hashCode(),
            intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
    }

    private fun replyAction(context: Context, spec: ConversationSpec, action: ReplyAction): NotificationCompat.Action {
        val reply = Intent(context, ConversationReplyReceiver::class.java)
            .putExtra(ConversationReplyReceiver.EXTRA_ACTION, action.id)
            .putExtra(ConversationReplyReceiver.EXTRA_DATA, spec.dataJson)
        // RemoteInput writes the typed text into the intent, so the PendingIntent must be mutable.
        val mutable = if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0
        return NotificationCompat.Action.Builder(
            R.drawable.ic_ask_tile,
            action.title,
            PendingIntent.getBroadcast(
                context,
                "${spec.id}/${action.id}".hashCode(),
                reply,
                PendingIntent.FLAG_UPDATE_CURRENT or mutable,
            ),
        )
            .addRemoteInput(RemoteInput.Builder(REPLY_KEY).setLabel(action.title).build())
            .setSemanticAction(NotificationCompat.Action.SEMANTIC_ACTION_REPLY)
            .setShowsUserInterface(false)
            .setAllowGeneratedReplies(false)
            .build()
    }

    /**
     * The bubble shows the conversation's client: a [ClientActivity] bound to
     * the client's instance tag, asked to open the conversation's link. It
     * attaches to the instance when the client already runs, and otherwise the
     * link makes the host runtime start the client into this very activity.
     */
    private fun bubble(context: Context, spec: ConversationSpec): NotificationCompat.BubbleMetadata? {
        val target = spec.conversation ?: return null
        val intent = Intent(context, ClientActivity::class.java)
            .putExtra(ClientInstances.EXTRA_TAG, target.tag)
            .putExtra(ClientInstances.EXTRA_CLIENT_ID, target.clientId)
            .putExtra(ClientInstances.EXTRA_TITLE, target.title)
            .putExtra(ClientInstances.EXTRA_LINK, target.link)
        // A bubble's PendingIntent must be mutable so the system can set its display bounds.
        val pending = PendingIntent.getActivity(
            context,
            "bubble:${spec.id}".hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0,
        )
        return NotificationCompat.BubbleMetadata.Builder(
            pending,
            IconCompat.createWithResource(context, R.mipmap.ic_launcher),
        )
            .setDesiredHeight(BUBBLE_HEIGHT_DP)
            .build()
    }

    private fun publishConversationShortcut(context: Context, id: String, spec: ConversationSpec, sender: Person) {
        val link = spec.conversation!!.link
        ShortcutManagerCompat.pushDynamicShortcut(
            context,
            ShortcutInfoCompat.Builder(context, id)
                .setShortLabel(spec.conversation.title.ifBlank { spec.title })
                .setLongLived(true)
                .setPerson(sender)
                .setCategories(setOf(CATEGORY))
                .setLocusId(LocusIdCompat(id))
                .setIcon(IconCompat.createWithResource(context, R.mipmap.ic_launcher))
                .setIntent(LaunchShortcuts.linkIntent(context, link))
                .build(),
        )
    }

    fun typedReply(intent: Intent): String? =
        RemoteInput.getResultsFromIntent(intent)?.getCharSequence(REPLY_KEY)?.toString()

    private const val BUBBLE_HEIGHT_DP = 600
}

/**
 * The person typed into a conversation notification's reply field. The reply
 * is posted by the host runtime, not here, so the receiver only hands it over:
 * if the process was killed, starting it brings the host runtime up and the
 * event is delivered when it is ready.
 */
class ConversationReplyReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val actionId = intent.getStringExtra(EXTRA_ACTION) ?: return
        val data = intent.getStringExtra(EXTRA_DATA) ?: return
        val input = ConversationNotifier.typedReply(intent) ?: return
        HostIngress.forward(ConversationSpec.event("action", actionId, input, data))
    }

    companion object {
        const val EXTRA_ACTION = "app.vibestudio.mobile.conversation.action"
        const val EXTRA_DATA = "app.vibestudio.mobile.conversation.data"
    }
}

/** `VibestudioConversationNotifications`: the host runtime's way to draw and retire inbox entries on Android. */
class VibestudioConversationNotificationsModule(
    reactContext: ReactApplicationContext,
) : ReactContextBaseJavaModule(reactContext) {
    override fun getName(): String = "VibestudioConversationNotifications"

    @ReactMethod
    fun display(spec: ReadableMap, promise: Promise) {
        try {
            ConversationNotifier.post(
                reactApplicationContext,
                ConversationSpec.parse(JSONObject(spec.toHashMap()).toString()),
            )
            promise.resolve(null)
        } catch (error: Throwable) {
            promise.reject("conversation_notification_failed", error.message ?: error.javaClass.simpleName, error)
        }
    }

    @ReactMethod
    fun cancel(id: String, promise: Promise) {
        try {
            ConversationNotifier.cancel(reactApplicationContext, id)
            promise.resolve(null)
        } catch (error: Throwable) {
            promise.reject("conversation_notification_failed", error.message ?: error.javaClass.simpleName, error)
        }
    }
}

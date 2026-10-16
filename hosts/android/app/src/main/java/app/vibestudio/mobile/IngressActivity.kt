package app.vibestudio.mobile

import android.app.Activity
import android.os.Bundle
import android.content.Intent
import org.json.JSONObject

/**
 * Where the OS delivers things meant for a client rather than for the host's
 * own screen: `vibestudio://c/...` links (pinned shortcuts) and text shared
 * with Vibestudio. It shows nothing. It forwards the request to the host
 * runtime's JavaScript, which routes it to the client that declares the intent
 * or accepts the type, and finishes.
 */
class IngressActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        forward(intent)
        finish()
    }

    private fun forward(intent: Intent) {
        val ingress = IngressIntent.classify(
            intent.action,
            intent.dataString,
            intent.type,
            intent.getCharSequenceExtra(Intent.EXTRA_TEXT),
        ) ?: return
        val event = when (ingress) {
            is IngressIntent.Link -> JSONObject().put("type", "link").put("url", ingress.url)
            is IngressIntent.Share ->
                JSONObject().put("type", "share-in").put("mimeType", ingress.mimeType).put("text", ingress.text)
        }
        HostIngress.forward(event)
    }
}

/** Hands an event to the host runtime's JavaScript once it is ready; the process may have just started. */
object HostIngress {
    private const val TAG = "host-ingress"

    fun forward(event: JSONObject) {
        HostRuntime.broker.afterReady(TAG) { HostRuntime.emitToHost(event) }
    }
}

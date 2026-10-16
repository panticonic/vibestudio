package app.vibestudio.mobile

/**
 * What the OS handed the host's ingress activity, reduced to the one thing the
 * host runtime's JavaScript acts on. Pure so it is unit tested without Android.
 *
 * Only `vibestudio://c/...` client links and shared text are ingress; the
 * pairing and panel links keep their own filter on [MainActivity].
 */
sealed class IngressIntent {
    /** A `vibestudio://c/<id>/<intent>` link (a pinned shortcut, a launcher menu). */
    data class Link(val url: String) : IngressIntent()

    /** Text shared with `ACTION_SEND`. */
    data class Share(val mimeType: String, val text: String) : IngressIntent()

    companion object {
        const val ACTION_VIEW = "android.intent.action.VIEW"
        const val ACTION_SEND = "android.intent.action.SEND"
        private const val CLIENT_LINK_PREFIX = "vibestudio://c/"

        fun classify(action: String?, dataString: String?, mimeType: String?, sharedText: CharSequence?): IngressIntent? =
            when (action) {
                ACTION_VIEW ->
                    dataString
                        ?.takeIf { it.startsWith(CLIENT_LINK_PREFIX, ignoreCase = true) }
                        ?.let { Link(it) }
                ACTION_SEND -> {
                    val text = sharedText?.toString()?.takeIf { it.isNotBlank() }
                    val type = mimeType?.takeIf { it.contains('/') }
                    if (text != null && type != null && type.startsWith("text/", ignoreCase = true)) Share(type, text) else null
                }
                else -> null
            }
    }
}

/** The question typed into the Ask tile's prompt. */
object AskRequest {
    /** The background intent the tile runs; the host picks the client that declares it. */
    const val INTENT = "ask"

    fun text(typed: CharSequence?): String? = typed?.toString()?.trim()?.takeIf { it.isNotEmpty() }
}

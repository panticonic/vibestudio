package app.vibestudio.mobile

/**
 * Request/response correlation between client instances and the host runtime's
 * JavaScript. It never interprets a request: it numbers it, hands it to
 * [dispatch], and settles the caller when the host runtime responds or rejects
 * for exactly that (tag, requestId).
 *
 * Until the host runtime calls [markReady] requests (and other deferred
 * actions) wait in arrival order. There is no timeout: readiness, a response,
 * or an authoritative terminal event ([dropClient], [hostDetached]) settles them.
 */
class ClientBrokerCore(private val dispatch: (ClientRequest) -> Unit) {
    data class ClientRequest(val tag: String, val requestId: String, val method: String, val argsJson: String)

    interface Completion {
        fun resolve(resultJson: String)
        fun reject(code: String, message: String)
    }

    private sealed class Queued(val tag: String) {
        class Request(tag: String, val method: String, val argsJson: String, val completion: Completion) : Queued(tag)
        class Action(tag: String, val run: () -> Unit) : Queued(tag)
    }

    private val lock = Any()
    private var ready = false
    private var nextId = 0L
    private val queue = ArrayList<Queued>()
    private val inFlight = HashMap<Pair<String, String>, Completion>()

    val isReady: Boolean get() = synchronized(lock) { ready }

    fun request(tag: String, method: String, argsJson: String, completion: Completion) {
        synchronized(lock) {
            if (!ready) {
                queue.add(Queued.Request(tag, method, argsJson, completion))
                return
            }
            send(tag, method, argsJson, completion)
        }
    }

    /** Run `action` now when the host runtime is ready, else when it becomes ready. `tag` scopes [dropClient]. */
    fun afterReady(tag: String, action: () -> Unit) {
        synchronized(lock) {
            if (!ready) {
                queue.add(Queued.Action(tag, action))
                return
            }
            action()
        }
    }

    fun markReady() {
        synchronized(lock) {
            ready = true
            // Dispatch under the lock so a request racing with readiness cannot overtake the queue.
            val waiting = queue.toList()
            queue.clear()
            for (item in waiting) {
                when (item) {
                    is Queued.Request -> send(item.tag, item.method, item.argsJson, item.completion)
                    is Queued.Action -> item.run()
                }
            }
        }
    }

    /** Host runtime JavaScript went away: what it was asked can no longer be answered. */
    fun hostDetached(code: String, message: String) {
        val failed = synchronized(lock) {
            ready = false
            inFlight.values.toList().also { inFlight.clear() }
        }
        failed.forEach { it.reject(code, message) }
    }

    fun respond(tag: String, requestId: String, resultJson: String): Boolean {
        val completion = synchronized(lock) { inFlight.remove(tag to requestId) } ?: return false
        completion.resolve(resultJson)
        return true
    }

    fun reject(tag: String, requestId: String, code: String, message: String): Boolean {
        val completion = synchronized(lock) { inFlight.remove(tag to requestId) } ?: return false
        completion.reject(code, message)
        return true
    }

    /** The client is gone (stopped, closed, crashed): settle everything it was waiting on. */
    fun dropClient(tag: String, code: String, message: String) {
        val failed = ArrayList<Completion>()
        synchronized(lock) {
            val iterator = inFlight.entries.iterator()
            while (iterator.hasNext()) {
                val entry = iterator.next()
                if (entry.key.first == tag) {
                    failed.add(entry.value)
                    iterator.remove()
                }
            }
            val queued = queue.iterator()
            while (queued.hasNext()) {
                val item = queued.next()
                if (item.tag != tag) continue
                if (item is Queued.Request) failed.add(item.completion)
                queued.remove()
            }
        }
        failed.forEach { it.reject(code, message) }
    }

    private fun send(tag: String, method: String, argsJson: String, completion: Completion) {
        val requestId = (++nextId).toString()
        inFlight[tag to requestId] = completion
        dispatch(ClientRequest(tag, requestId, method, argsJson))
    }
}

package app.vibestudio.mobile

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ClientBrokerCoreTest {
    private class Recorder : ClientBrokerCore.Completion {
        var result: String? = null
        var failure: Pair<String, String>? = null
        override fun resolve(resultJson: String) { result = resultJson }
        override fun reject(code: String, message: String) { failure = code to message }
    }

    private val dispatched = ArrayList<ClientBrokerCore.ClientRequest>()
    private val core = ClientBrokerCore { dispatched.add(it) }

    @Test fun requestsWaitForReadinessThenDispatchInOrder() {
        val a = Recorder()
        val b = Recorder()
        core.request("t1", "m1", "[1]", a)
        core.request("t2", "m2", "[2]", b)
        assertTrue(dispatched.isEmpty())
        core.markReady()
        assertEquals(listOf("m1", "m2"), dispatched.map { it.method })
        assertEquals(listOf("t1", "t2"), dispatched.map { it.tag })
        assertTrue(dispatched.map { it.requestId }.toSet().size == 2)
    }

    @Test fun respondSettlesOnlyTheMatchingTagAndRequest() {
        core.markReady()
        val mine = Recorder()
        val other = Recorder()
        core.request("t1", "m", "[]", mine)
        core.request("t2", "m", "[]", other)
        val id = dispatched[0].requestId
        assertFalse("another tag cannot answer for t1", core.respond("t2", id, "\"x\""))
        assertTrue(core.respond("t1", id, "\"ok\""))
        assertEquals("\"ok\"", mine.result)
        assertEquals(null, other.result)
        assertFalse("a request settles once", core.respond("t1", id, "\"again\""))
    }

    @Test fun rejectCarriesCodeAndMessage() {
        core.markReady()
        val r = Recorder()
        core.request("t1", "m", "[]", r)
        assertTrue(core.reject("t1", dispatched[0].requestId, "denied", "no"))
        assertEquals("denied" to "no", r.failure)
    }

    @Test fun dropClientSettlesQueuedAndInFlightForThatTagOnly() {
        val queued = Recorder()
        core.request("t1", "m", "[]", queued)
        var ran = false
        core.afterReady("t1") { ran = true }
        core.dropClient("t1", "client-stopped", "gone")
        assertEquals("client-stopped" to "gone", queued.failure)
        core.markReady()
        assertFalse("a dropped client's deferred action never runs", ran)
        assertTrue(dispatched.isEmpty())

        val inFlight = Recorder()
        val survivor = Recorder()
        core.request("t1", "m", "[]", inFlight)
        core.request("t2", "m", "[]", survivor)
        core.dropClient("t1", "client-closed", "closed")
        assertEquals("client-closed" to "closed", inFlight.failure)
        assertEquals(null, survivor.failure)
        assertTrue(core.respond("t2", dispatched.last().requestId, "null"))
    }

    @Test fun hostDetachedFailsInFlightAndRequiresReadinessAgain() {
        core.markReady()
        val r = Recorder()
        core.request("t1", "m", "[]", r)
        core.hostDetached("host-unavailable", "restarted")
        assertEquals("host-unavailable" to "restarted", r.failure)
        assertFalse(core.isReady)
        val later = Recorder()
        core.request("t1", "m", "[]", later)
        assertEquals(1, dispatched.size)
        core.markReady()
        assertEquals(2, dispatched.size)
    }

    @Test fun afterReadyRunsImmediatelyOnceReady() {
        core.markReady()
        var ran = false
        core.afterReady("t") { ran = true }
        assertTrue(ran)
    }
}

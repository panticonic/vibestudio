package app.vibestudio.mobile

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.facebook.react.bridge.Callback
import com.facebook.react.bridge.JavaOnlyArray
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.PromiseImpl
import com.facebook.react.bridge.BridgeReactContext
import com.facebook.react.bridge.ReadableMap
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class IrohLifecycleTest {
    private fun module() = VibestudioIrohModule(BridgeReactContext(
        InstrumentationRegistry.getInstrumentation().targetContext
    ))

    private fun result(invoke: (Promise) -> Unit): CompletableDeferred<Any?> {
        val result = CompletableDeferred<Any?>()
        invoke(PromiseImpl(
            Callback { values -> result.complete(values.firstOrNull()) },
            Callback { values -> result.completeExceptionally(IllegalStateException(
                (values.firstOrNull() as? ReadableMap)?.getString("message") ?: "Native operation rejected"
            )) }
        ))
        return result
    }

    @Test(timeout = 60_000) fun invalidationSettlesPendingAcceptAndReleasesIdentity(): Unit = runBlocking {
        val first = module()
        val identity = result { first.createIdentity(it) }.await() as ReadableMap
        val identityId = identity.getString("identityId")!!
        val relays = JavaOnlyArray.of("https://euc1-1.relay.n0.iroh.link/")
        val endpoint = result { first.bind(identityId, relays, "dGVzdA==", it) }.await() as ReadableMap
        val pendingAccept = result { first.accept(endpoint.getString("endpointHandle")!!, it) }
        val replacement = module()
        try {
            first.invalidate()
            assertTrue(runCatching { pendingAccept.await() }.isFailure)
            val rebound = result { replacement.bind(identityId, relays, "dGVzdA==", it) }.await() as ReadableMap
            assertTrue(rebound.getString("endpointId") == endpoint.getString("endpointId"))
            result { replacement.shutdownEndpoint(rebound.getString("endpointHandle")!!, it) }.await()
            result { replacement.deleteIdentity(identityId, it) }.await()
        } finally {
            first.invalidate()
            replacement.invalidate()
        }
    }

    @Test(timeout = 60_000) fun invalidatedRuntimeRejectsNewCalls() = runBlocking {
        val retired = module()
        retired.invalidate()
        retired.invalidate()
        val failure = runCatching { result { retired.createIdentity(it) }.await() }.exceptionOrNull()
        assertTrue(failure != null)
    }
}

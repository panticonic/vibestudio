package app.vibestudio.mobile

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.uimanager.ViewManager

/**
 * `VibestudioClientBroker`: the only door from a client instance to the host
 * runtime. It is constructed with this instance's tag, so a client cannot
 * name another client; it forwards `request` verbatim and resolves with what
 * the host runtime answers (rejecting with the host's code and message).
 */
class VibestudioClientBrokerModule(
    reactContext: ReactApplicationContext,
    private val tag: String,
    private val clientId: String,
) : ReactContextBaseJavaModule(reactContext) {
    override fun getName(): String = "VibestudioClientBroker"

    override fun getConstants(): MutableMap<String, Any> = hashMapOf("tag" to tag, "clientId" to clientId)

    @ReactMethod
    fun request(method: String, argsJson: String, promise: Promise) {
        HostRuntime.broker.request(tag, method, argsJson, object : ClientBrokerCore.Completion {
            override fun resolve(resultJson: String) = promise.resolve(resultJson)
            override fun reject(code: String, message: String) = promise.reject(code, message)
        })
    }
}

class VibestudioClientBrokerPackage(
    private val tag: String,
    private val clientId: String,
) : ReactPackage {
    override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
        listOf(VibestudioClientBrokerModule(reactContext, tag, clientId))

    override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
        emptyList()
}

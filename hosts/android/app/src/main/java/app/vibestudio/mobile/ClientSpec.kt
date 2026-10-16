package app.vibestudio.mobile

import com.facebook.react.bridge.ReadableMap

/** A verified bundle a client instance runs (`NativeClientBundle`). */
data class ClientBundle(
    val bundlePath: String,
    val integrity: String,
    val buildKey: String,
    val assetsRoot: String,
) {
    companion object {
        fun parse(map: ReadableMap) = ClientBundle(
            bundlePath = string(map, "bundlePath"),
            integrity = ArtifactIntegrity.require(string(map, "integrity")),
            buildKey = string(map, "buildKey"),
            assetsRoot = string(map, "assetsRoot"),
        )

        fun string(map: ReadableMap, key: String): String =
            (if (map.hasKey(key) && !map.isNull(key)) map.getString(key) else null)
                ?.takeIf { it.isNotEmpty() }
                ?: throw NativeFailure(NativeFailure.INVALID_ARGUMENT, "Client spec is missing $key")
    }
}

/** `NativeClientSpec`: one client instance. */
data class ClientSpec(
    val tag: String,
    val clientId: String,
    val title: String,
    val bundle: ClientBundle,
    val grantedCapabilities: List<String>,
) {
    fun withBundle(next: ClientBundle) = copy(bundle = next)

    companion object {
        fun parse(map: ReadableMap): ClientSpec {
            val granted = map.getArray("grantedCapabilities")
                ?: throw NativeFailure(NativeFailure.INVALID_ARGUMENT, "Client spec is missing grantedCapabilities")
            return ClientSpec(
                tag = ClientBundle.string(map, "tag"),
                clientId = ClientBundle.string(map, "clientId"),
                title = ClientBundle.string(map, "title"),
                bundle = ClientBundle.parse(map),
                grantedCapabilities = (0 until granted.size()).map { granted.getString(it) ?: "" },
            )
        }
    }
}

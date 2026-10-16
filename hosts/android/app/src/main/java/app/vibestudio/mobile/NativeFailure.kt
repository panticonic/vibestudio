package app.vibestudio.mobile

/**
 * A failure that crosses the native boundary with a stable `code`, so the
 * host runtime's JavaScript can tell an integrity refusal from an I/O error.
 */
class NativeFailure(val code: String, message: String, cause: Throwable? = null) :
    Exception(message, cause) {
    companion object {
        const val INTEGRITY_MISMATCH = "integrity-mismatch"
        const val INVALID_ARGUMENT = "invalid-argument"
        const val ARTIFACT_MISSING = "artifact-missing"
        const val CLIENT_NOT_RUNNING = "client-not-running"
    }
}

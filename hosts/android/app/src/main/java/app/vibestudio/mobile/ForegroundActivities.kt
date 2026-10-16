package app.vibestudio.mobile

import android.app.Activity
import android.app.Application
import android.content.Intent
import android.os.Bundle
import java.lang.ref.WeakReference
import java.util.concurrent.CopyOnWriteArraySet

/**
 * Tracks which activity is resumed, across the host surface and every client's
 * task. Native code that starts an activity on a client's behalf (a document
 * picker for a client's file chooser, the browser-import picker) must launch
 * from whichever activity is in front, and the result returns to that
 * activity rather than to any React context, so results are routed through
 * [dispatchResult] by every activity this app owns.
 */
object ForegroundActivities : Application.ActivityLifecycleCallbacks {
    fun interface ResultListener {
        /** @return true when the request code was this listener's and the result is consumed. */
        fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?): Boolean
    }

    @Volatile private var resumed: WeakReference<Activity>? = null
    private val listeners = CopyOnWriteArraySet<ResultListener>()

    fun current(): Activity? = resumed?.get()?.takeUnless { it.isFinishing || it.isDestroyed }

    fun addResultListener(listener: ResultListener) {
        listeners.add(listener)
    }

    fun removeResultListener(listener: ResultListener) {
        listeners.remove(listener)
    }

    /** Offer an activity result to native listeners; an activity forwards it to its React instance as well. */
    fun dispatchResult(requestCode: Int, resultCode: Int, data: Intent?) {
        for (listener in listeners) {
            if (listener.onActivityResult(requestCode, resultCode, data)) return
        }
    }

    override fun onActivityResumed(activity: Activity) {
        resumed = WeakReference(activity)
    }

    override fun onActivityPaused(activity: Activity) {
        if (resumed?.get() === activity) resumed = null
    }

    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit
    override fun onActivityStarted(activity: Activity) = Unit
    override fun onActivityStopped(activity: Activity) = Unit
    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit
    override fun onActivityDestroyed(activity: Activity) {
        if (resumed?.get() === activity) resumed = null
    }
}

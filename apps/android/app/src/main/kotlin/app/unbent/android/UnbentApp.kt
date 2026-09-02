package app.unbent.android

import android.app.Application
import app.unbent.android.share.CaptureNotifications
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

class UnbentApp : Application() {
    /**
     * For work that must outlive the screen that started it: a title save the user
     * pressed Back on. A screen's own scope is cancelled when the screen goes, which is
     * right for loading and wrong for saving.
     */
    val saves = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)

    override fun onCreate() {
        super.onCreate()
        CaptureNotifications.createChannel(this)
    }
}

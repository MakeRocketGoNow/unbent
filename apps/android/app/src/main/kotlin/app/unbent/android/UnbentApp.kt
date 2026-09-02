package app.unbent.android

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
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

        // One low-importance channel: a capture finishing should be findable in the shade,
        // not interrupt whatever the user is doing.
        val channel = NotificationChannel(
            CHANNEL_UPLOADS,
            getString(R.string.channel_uploads),
            NotificationManager.IMPORTANCE_LOW,
        ).apply { description = getString(R.string.channel_uploads_desc) }

        getSystemService(NotificationManager::class.java)?.createNotificationChannel(channel)
    }

    companion object {
        const val CHANNEL_UPLOADS = "uploads"
    }
}

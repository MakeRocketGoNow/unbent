package app.unbent.android

import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager

class UnbentApp : Application() {
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

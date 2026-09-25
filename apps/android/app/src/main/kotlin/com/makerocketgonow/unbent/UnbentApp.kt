package com.makerocketgonow.unbent

import android.app.Application
import com.makerocketgonow.unbent.share.CaptureNotifications

class UnbentApp : Application() {
    override fun onCreate() {
        super.onCreate()
        CaptureNotifications.createChannel(this)
    }
}

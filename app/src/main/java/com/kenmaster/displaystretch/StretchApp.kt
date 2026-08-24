package com.kenmaster.displaystretch

import android.app.Application

class StretchApp : Application() {
    override fun onCreate() {
        super.onCreate()
        instance = this
    }

    companion object {
        lateinit var instance: StretchApp
            private set
    }
}

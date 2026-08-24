package com.kenmaster.displaystretch.shell

import android.annotation.SuppressLint
import android.content.AttributionSource
import android.content.Context
import android.content.ContextWrapper
import android.os.Process

/**
 * DisplayManagerService checks that the calling uid matches the package name.
 * Shizuku started via ADB runs as shell (uid 2000), so we must report com.android.shell.
 */
@SuppressLint("PrivateApi")
class FakeShellContext(base: Context) : ContextWrapper(base) {
    override fun getPackageName(): String = PACKAGE_NAME

    override fun getOpPackageName(): String = PACKAGE_NAME

    override fun getApplicationContext(): Context = this

    override fun getAttributionSource(): AttributionSource {
        return AttributionSource.Builder(Process.SHELL_UID)
            .setPackageName(PACKAGE_NAME)
            .build()
    }

    override fun getDeviceId(): Int = 0

    companion object {
        const val PACKAGE_NAME = "com.android.shell"

        fun from(optional: Context?): FakeShellContext {
            val base = optional ?: systemContext()
            return FakeShellContext(base)
        }

        private fun systemContext(): Context {
            val atClass = Class.forName("android.app.ActivityThread")
            val current = atClass.getMethod("currentActivityThread").invoke(null)
                ?: atClass.getMethod("systemMain").invoke(null)
            return atClass.getMethod("getSystemContext").invoke(current) as Context
        }
    }
}

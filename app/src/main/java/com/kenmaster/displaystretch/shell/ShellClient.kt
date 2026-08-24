package com.kenmaster.displaystretch.shell

import android.content.ComponentName
import android.content.Context
import android.content.ServiceConnection
import android.os.IBinder
import com.kenmaster.displaystretch.BuildConfig
import com.kenmaster.displaystretch.IShellService
import rikka.shizuku.Shizuku

object ShellClient {
    @Volatile
    var service: IShellService? = null
        private set

    val isBound: Boolean
        get() = service?.asBinder()?.pingBinder() == true

    private val args = Shizuku.UserServiceArgs(
        ComponentName(BuildConfig.APPLICATION_ID, ShellService::class.java.name),
    )
        .daemon(false)
        .processNameSuffix("shell")
        .debuggable(BuildConfig.DEBUG)
        .version(BuildConfig.VERSION_CODE)
        .tag("display-stretch-shell")

    private val connection = object : ServiceConnection {
        override fun onServiceConnected(name: ComponentName, binder: IBinder) {
            if (binder.pingBinder()) {
                service = IShellService.Stub.asInterface(binder)
            }
        }

        override fun onServiceDisconnected(name: ComponentName) {
            service = null
        }
    }

    fun bind(context: Context) {
        if (!Shizuku.pingBinder()) return
        if (Shizuku.checkSelfPermission() != android.content.pm.PackageManager.PERMISSION_GRANTED) return
        if (isBound) return
        Shizuku.bindUserService(args, connection)
    }

    fun unbind() {
        try {
            Shizuku.unbindUserService(args, connection, true)
        } catch (_: Throwable) {
        }
        service = null
    }
}

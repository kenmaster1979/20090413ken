package com.kenmaster.displaystretch

import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import android.service.quicksettings.Tile
import android.service.quicksettings.TileService
import com.kenmaster.displaystretch.shell.ShellClient

class RestoreTileService : TileService() {
    override fun onStartListening() {
        super.onStartListening()
        qsTile?.apply {
            state = Tile.STATE_ACTIVE
            label = getString(R.string.restore_tile_label)
            updateTile()
        }
    }

    override fun onClick() {
        StretchActivity.stopIfRunning()
        try {
            ShellClient.service?.resetWmSize()
        } catch (_: Exception) {
        }
        val intent = Intent(this, MainActivity::class.java).apply {
            action = MainActivity.ACTION_RESTORE
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        }
        val pending = PendingIntent.getActivity(
            this,
            0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        if (Build.VERSION.SDK_INT >= 34) {
            startActivityAndCollapse(pending)
        } else {
            @Suppress("DEPRECATION")
            startActivityAndCollapse(intent)
        }
    }
}

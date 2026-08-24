package com.kenmaster.displaystretch

import android.annotation.SuppressLint
import android.os.Bundle
import android.view.MotionEvent
import android.view.SurfaceHolder
import android.view.WindowManager
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.kenmaster.displaystretch.databinding.ActivityStretchBinding
import com.kenmaster.displaystretch.shell.ShellClient
import java.lang.ref.WeakReference

class StretchActivity : AppCompatActivity(), SurfaceHolder.Callback {
    private lateinit var binding: ActivityStretchBinding
    private var displayId: Int = -1
    private var virtualWidth = 0
    private var virtualHeight = 0
    private var released = false
    private var sessionStarted = false
    private var downTime = 0L

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        instance = WeakReference(this)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        hideSystemBars()

        binding = ActivityStretchBinding.inflate(layoutInflater)
        setContentView(binding.root)

        val metrics = resources.displayMetrics
        val bounds = windowManager.currentWindowMetrics.bounds
        val ratio = StretchRatio.valueOf(
            intent.getStringExtra(EXTRA_RATIO) ?: StretchRatio.RATIO_4_3.name,
        )
        val size = DisplayMath.virtualSize(
            bounds.width(),
            bounds.height(),
            metrics.densityDpi,
            ratio,
        )
        virtualWidth = size.width
        virtualHeight = size.height

        binding.statusText.text =
            "${intent.getStringExtra(EXTRA_LABEL)}  ${size.label} → ${bounds.width()}x${bounds.height()}"
        binding.exitButton.setOnClickListener { closeSession() }
        onBackPressedDispatcher.addCallback(
            this,
            object : OnBackPressedCallback(true) {
                override fun handleOnBackPressed() {
                    closeSession()
                }
            },
        )

        binding.surfaceView.setOnTouchListener { view, event ->
            forwardTouch(view.width, view.height, event)
            true
        }
        binding.surfaceView.holder.setKeepScreenOn(true)
        binding.surfaceView.holder.setFixedSize(virtualWidth, virtualHeight)
        binding.surfaceView.holder.addCallback(this)
    }

    private fun hideSystemBars() {
        WindowInsetsControllerCompat(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior =
                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }

    override fun surfaceCreated(holder: SurfaceHolder) = Unit

    override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
        if (sessionStarted) return
        val service = ShellClient.service
        if (service == null) {
            toast("Shizuku 服务断开，无法创建虚拟屏")
            closeSession()
            return
        }
        try {
            val density = resources.displayMetrics.densityDpi
            displayId = service.createVirtualDisplay(
                holder.surface,
                virtualWidth,
                virtualHeight,
                density,
            )
            val launchResult = service.launchOnDisplay(
                intent.getStringExtra(EXTRA_PACKAGE).orEmpty(),
                intent.getStringExtra(EXTRA_COMPONENT).orEmpty(),
                displayId,
                intent.getBooleanExtra(EXTRA_FORCE_STOP, true),
            )
            sessionStarted = true
            binding.statusText.text =
                "${binding.statusText.text}  display=$displayId\n$launchResult"
        } catch (e: Exception) {
            toast("创建虚拟屏失败：${e.message}")
            closeSession()
        }
    }

    override fun surfaceDestroyed(holder: SurfaceHolder) {
        closeSession()
    }

    @SuppressLint("ClickableViewAccessibility")
    private fun forwardTouch(viewWidth: Int, viewHeight: Int, event: MotionEvent): Boolean {
        val service = ShellClient.service ?: return false
        if (displayId < 0 || viewWidth <= 0 || viewHeight <= 0) return false
        val count = event.pointerCount
        val ids = IntArray(count)
        val xs = FloatArray(count)
        val ys = FloatArray(count)
        val pressures = FloatArray(count)
        val scaleX = virtualWidth.toFloat() / viewWidth
        val scaleY = virtualHeight.toFloat() / viewHeight
        for (i in 0 until count) {
            ids[i] = event.getPointerId(i)
            xs[i] = event.getX(i) * scaleX
            ys[i] = event.getY(i) * scaleY
            pressures[i] = event.getPressure(i).coerceAtLeast(0.1f)
        }
        if (event.actionMasked == MotionEvent.ACTION_DOWN) {
            downTime = event.downTime
        }
        return try {
            service.injectMotion(
                displayId,
                downTime,
                event.eventTime,
                event.action,
                count,
                ids,
                xs,
                ys,
                pressures,
                event.metaState,
            )
        } catch (_: Exception) {
            false
        }
    }

    private fun closeSession() {
        if (released) {
            if (!isFinishing) finish()
            return
        }
        released = true
        try {
            ShellClient.service?.releaseVirtualDisplay()
        } catch (_: Exception) {
        }
        displayId = -1
        sessionStarted = false
        if (!isFinishing) finish()
    }

    override fun onDestroy() {
        closeSession()
        if (instance?.get() === this) {
            instance = null
        }
        super.onDestroy()
    }

    private fun toast(message: String) {
        Toast.makeText(this, message, Toast.LENGTH_LONG).show()
    }

    companion object {
        const val EXTRA_PACKAGE = "package"
        const val EXTRA_COMPONENT = "component"
        const val EXTRA_LABEL = "label"
        const val EXTRA_RATIO = "ratio"
        const val EXTRA_FORCE_STOP = "force_stop"

        @Volatile
        var instance: WeakReference<StretchActivity>? = null

        fun stopIfRunning() {
            instance?.get()?.closeSession()
        }
    }
}

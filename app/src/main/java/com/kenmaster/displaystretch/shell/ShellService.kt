package com.kenmaster.displaystretch.shell

import android.annotation.SuppressLint
import android.content.Context
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.os.Build
import android.system.Os
import android.util.Log
import android.view.InputDevice
import android.view.InputEvent
import android.view.MotionEvent
import android.view.Surface
import androidx.annotation.Keep
import com.kenmaster.displaystretch.IShellService
import java.io.BufferedReader
import java.io.InputStreamReader
import java.lang.reflect.Constructor

@SuppressLint("PrivateApi", "SoonBlockedPrivateApi")
class ShellService : IShellService.Stub {
    private var appContext: Context? = null
    private var virtualDisplay: VirtualDisplay? = null

    constructor() {
        Log.i(TAG, "ShellService pid=${Os.getpid()} uid=${Os.getuid()}")
        exemptHiddenApis()
    }

    @Keep
    constructor(context: Context) : this() {
        appContext = context
        Log.i(TAG, "ShellService with context=$context")
    }

    override fun destroy() {
        releaseVirtualDisplay()
        System.exit(0)
    }

    override fun exit() {
        destroy()
    }

    override fun getWmSize(): String {
        val size = exec("wm", "size")
        val density = exec("wm", "density")
        return (size + "\n" + density).trim()
    }

    override fun resetWmSize(): String {
        val size = exec("wm", "size", "reset")
        val density = exec("wm", "density", "reset")
        return (size + "\n" + density + "\n" + getWmSize()).trim()
    }

    override fun createVirtualDisplay(
        surface: Surface,
        width: Int,
        height: Int,
        densityDpi: Int,
    ): Int {
        releaseVirtualDisplay()
        val dm = newDisplayManager()
        var lastError: Exception? = null
        for (flags in flagCandidates()) {
            try {
                val vd = dm.createVirtualDisplay(
                    DISPLAY_NAME,
                    width,
                    height,
                    densityDpi,
                    surface,
                    flags,
                )
                virtualDisplay = vd
                val id = vd.display.displayId
                Log.i(TAG, "virtual display id=$id ${width}x$height dpi=$densityDpi flags=0x${flags.toString(16)}")
                return id
            } catch (e: Exception) {
                lastError = e
                Log.w(TAG, "createVirtualDisplay failed flags=0x${flags.toString(16)}: ${e.message}")
            }
        }
        throw IllegalStateException("无法创建虚拟屏: ${lastError?.message}", lastError)
    }

    override fun releaseVirtualDisplay() {
        try {
            virtualDisplay?.release()
        } catch (e: Exception) {
            Log.w(TAG, "releaseVirtualDisplay", e)
        } finally {
            virtualDisplay = null
        }
    }

    override fun launchOnDisplay(
        packageName: String,
        componentFlattened: String,
        displayId: Int,
        forceStop: Boolean,
    ): String {
        val out = StringBuilder()
        if (forceStop && packageName.isNotBlank()) {
            out.append(exec("am", "force-stop", packageName)).append('\n')
        }
        out.append(
            exec(
                "am", "start",
                "--user", "0",
                "--display", displayId.toString(),
                "-n", componentFlattened,
                "-f", "0x18000000",
            ),
        )
        return out.toString().trim()
    }

    override fun injectMotion(
        displayId: Int,
        downTime: Long,
        eventTime: Long,
        action: Int,
        pointerCount: Int,
        pointerIds: IntArray,
        xs: FloatArray,
        ys: FloatArray,
        pressures: FloatArray,
        metaState: Int,
    ): Boolean {
        if (pointerCount <= 0) return false
        val properties = Array(pointerCount) { i ->
            MotionEvent.PointerProperties().apply {
                id = pointerIds[i]
                toolType = MotionEvent.TOOL_TYPE_FINGER
            }
        }
        val coords = Array(pointerCount) { i ->
            MotionEvent.PointerCoords().apply {
                x = xs[i]
                y = ys[i]
                pressure = if (i < pressures.size) pressures[i] else 1f
                size = 1f
            }
        }
        val event = MotionEvent.obtain(
            downTime,
            eventTime,
            action,
            pointerCount,
            properties,
            coords,
            metaState,
            0,
            1f,
            1f,
            0,
            0,
            InputDevice.SOURCE_TOUCHSCREEN,
            0,
        )
        return try {
            InputEvent::class.java.getMethod("setDisplayId", Int::class.javaPrimitiveType)
                .invoke(event, displayId)
            injectInputEvent(event)
        } finally {
            event.recycle()
        }
    }

    private fun injectInputEvent(event: InputEvent): Boolean {
        val manager = inputManager()
        val method = manager.javaClass.getMethod(
            "injectInputEvent",
            InputEvent::class.java,
            Int::class.javaPrimitiveType,
        )
        return method.invoke(manager, event, INJECT_ASYNC) as Boolean
    }

    private fun inputManager(): Any {
        val clazz = Class.forName("android.hardware.input.InputManager")
        return try {
            clazz.getMethod("getInstance").invoke(null)
        } catch (_: NoSuchMethodException) {
            FakeShellContext.from(appContext).getSystemService(Context.INPUT_SERVICE)
                ?: throw IllegalStateException("InputManager unavailable")
        }
    }

    private fun newDisplayManager(): DisplayManager {
        val ctor: Constructor<DisplayManager> =
            DisplayManager::class.java.getDeclaredConstructor(Context::class.java)
        ctor.isAccessible = true
        return ctor.newInstance(FakeShellContext.from(appContext))
    }

    private fun flagCandidates(): List<Int> {
        val supportTouch = 1 shl 6
        val rotates = 1 shl 7
        val destroyContent = 1 shl 8
        val systemDecor = 1 shl 9
        val trusted = 1 shl 10
        val ownGroup = 1 shl 11
        val alwaysUnlocked = 1 shl 12
        val ownFocus = 1 shl 14
        val deviceGroup = 1 shl 15

        val base = DisplayManager.VIRTUAL_DISPLAY_FLAG_PUBLIC or
            DisplayManager.VIRTUAL_DISPLAY_FLAG_PRESENTATION or
            DisplayManager.VIRTUAL_DISPLAY_FLAG_OWN_CONTENT_ONLY or
            supportTouch or
            rotates

        val android13 = if (Build.VERSION.SDK_INT >= 33) {
            trusted or ownGroup or alwaysUnlocked
        } else {
            0
        }
        val android14 = if (Build.VERSION.SDK_INT >= 34) {
            ownFocus or deviceGroup
        } else {
            0
        }

        return listOf(
            base or destroyContent or systemDecor or android13 or android14,
            base or destroyContent or systemDecor or android13,
            base or destroyContent or systemDecor,
            base or supportTouch,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_PUBLIC or
                DisplayManager.VIRTUAL_DISPLAY_FLAG_PRESENTATION or
                supportTouch,
        ).distinct()
    }

    private fun exec(vararg command: String): String {
        val process = ProcessBuilder(*command)
            .redirectErrorStream(true)
            .start()
        val output = BufferedReader(InputStreamReader(process.inputStream)).readText()
        process.waitFor()
        return output.trim()
    }

    private fun exemptHiddenApis() {
        try {
            val vmRuntime = Class.forName("dalvik.system.VMRuntime")
            val runtime = vmRuntime.getMethod("getRuntime").invoke(null)
            vmRuntime.getMethod("setHiddenApiExemptions", Array<String>::class.java)
                .invoke(runtime, arrayOf("L"))
        } catch (_: Throwable) {
        }
    }

    companion object {
        private const val TAG = "DisplayStretchShell"
        private const val DISPLAY_NAME = "display-stretch"
        private const val INJECT_ASYNC = 0
    }
}

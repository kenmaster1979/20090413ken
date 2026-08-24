package com.kenmaster.displaystretch

import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.widget.RadioGroup
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import com.kenmaster.displaystretch.databinding.ActivityMainBinding
import com.kenmaster.displaystretch.shell.ShellClient
import rikka.shizuku.Shizuku

class MainActivity : AppCompatActivity() {
    private lateinit var binding: ActivityMainBinding
    private var selectedPackage: String? = null
    private var selectedComponent: String? = null
    private var selectedLabel: String? = null

    private val pickerLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        if (result.resultCode != RESULT_OK) return@registerForActivityResult
        val data = result.data ?: return@registerForActivityResult
        selectedPackage = data.getStringExtra(AppPickerActivity.EXTRA_PACKAGE)
        selectedComponent = data.getStringExtra(AppPickerActivity.EXTRA_COMPONENT)
        selectedLabel = data.getStringExtra(AppPickerActivity.EXTRA_LABEL)
        binding.selectedApp.text = "${selectedLabel}\n${selectedPackage}"
    }

    private val shizukuPermissionListener =
        Shizuku.OnRequestPermissionResultListener { _, grantResult ->
            refreshShizuku()
            if (grantResult == PackageManager.PERMISSION_GRANTED) {
                ShellClient.bind(this)
            }
        }

    private val binderListener = object : Shizuku.OnBinderReceivedListener {
        override fun onBinderReceived() {
            runOnUiThread { refreshShizuku() }
        }
    }

    private val binderDeadListener = object : Shizuku.OnBinderDeadListener {
        override fun onBinderDead() {
            runOnUiThread { refreshShizuku() }
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, true)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        Shizuku.addRequestPermissionResultListener(shizukuPermissionListener)
        Shizuku.addBinderReceivedListener(binderListener)
        Shizuku.addBinderDeadListener(binderDeadListener)

        binding.authorize.setOnClickListener { requestShizuku() }
        binding.resetWm.setOnClickListener { resetWm() }
        binding.pickApp.setOnClickListener {
            pickerLauncher.launch(Intent(this, AppPickerActivity::class.java))
        }
        binding.startStretch.setOnClickListener { startStretch() }
        binding.ratioGroup.setOnCheckedChangeListener { _: RadioGroup, _ ->
            refreshVirtualPreview()
        }

        if (intent.action == ACTION_RESTORE) {
            resetWm()
        }

        refreshPhysical()
        refreshVirtualPreview()
        refreshShizuku()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        if (intent.action == ACTION_RESTORE) {
            resetWm()
        }
    }

    override fun onResume() {
        super.onResume()
        refreshShizuku()
        refreshWmSize()
        refreshVirtualPreview()
    }

    override fun onDestroy() {
        Shizuku.removeRequestPermissionResultListener(shizukuPermissionListener)
        Shizuku.removeBinderReceivedListener(binderListener)
        Shizuku.removeBinderDeadListener(binderDeadListener)
        super.onDestroy()
    }

    private fun refreshPhysical() {
        val metrics = resources.displayMetrics
        val bounds = windowManager.currentWindowMetrics.bounds
        binding.physicalSize.text = getString(
            R.string.physical_size,
            bounds.width(),
            bounds.height(),
            metrics.densityDpi,
        )
    }

    private fun refreshVirtualPreview() {
        val metrics = resources.displayMetrics
        val bounds = windowManager.currentWindowMetrics.bounds
        val size = DisplayMath.virtualSize(
            bounds.width(),
            bounds.height(),
            metrics.densityDpi,
            currentRatio(),
        )
        binding.virtualSize.text = getString(
            R.string.virtual_size,
            size.width,
            size.height,
            size.densityDpi,
        )
    }

    private fun currentRatio(): StretchRatio {
        return if (binding.ratio43.isChecked) StretchRatio.RATIO_4_3 else StretchRatio.RATIO_16_9
    }

    private fun refreshShizuku() {
        when {
            !Shizuku.pingBinder() -> {
                binding.shizukuStatus.text = getString(R.string.shizuku_not_running)
                binding.shizukuStatus.setTextColor(getColor(R.color.danger))
            }
            Shizuku.checkSelfPermission() != PackageManager.PERMISSION_GRANTED -> {
                binding.shizukuStatus.text = getString(R.string.shizuku_need_permission)
                binding.shizukuStatus.setTextColor(getColor(R.color.accent))
            }
            else -> {
                binding.shizukuStatus.text = getString(R.string.shizuku_ok)
                binding.shizukuStatus.setTextColor(getColor(R.color.ok))
                ShellClient.bind(this)
                refreshWmSize()
            }
        }
    }

    private fun requestShizuku() {
        if (!Shizuku.pingBinder()) {
            toast(getString(R.string.shizuku_not_running))
            return
        }
        if (Shizuku.checkSelfPermission() == PackageManager.PERMISSION_GRANTED) {
            ShellClient.bind(this)
            refreshShizuku()
            return
        }
        Shizuku.requestPermission(REQUEST_SHIZUKU)
    }

    private fun refreshWmSize() {
        val service = ShellClient.service ?: return
        try {
            binding.wmSize.text = getString(R.string.current_wm, service.wmSize)
        } catch (e: Exception) {
            binding.wmSize.text = e.message
        }
    }

    private fun resetWm() {
        val service = ShellClient.service
        if (service == null) {
            toast(getString(R.string.need_shizuku))
            return
        }
        try {
            val result = service.resetWmSize()
            binding.wmSize.text = getString(R.string.current_wm, result)
            toast(getString(R.string.restore_done))
        } catch (e: Exception) {
            toast(e.message ?: "reset failed")
        }
    }

    private fun startStretch() {
        if (!ShellClient.isBound) {
            ShellClient.bind(this)
            toast(getString(R.string.need_shizuku))
            refreshShizuku()
            return
        }
        val pkg = selectedPackage
        val component = selectedComponent
        if (pkg.isNullOrBlank() || component.isNullOrBlank()) {
            toast(getString(R.string.no_app_selected))
            return
        }
        // Leftover wm size from older stretch tools would letterbox this Activity too.
        try {
            ShellClient.service?.resetWmSize()
        } catch (_: Exception) {
        }
        startActivity(
            Intent(this, StretchActivity::class.java)
                .putExtra(StretchActivity.EXTRA_PACKAGE, pkg)
                .putExtra(StretchActivity.EXTRA_COMPONENT, component)
                .putExtra(StretchActivity.EXTRA_LABEL, selectedLabel)
                .putExtra(StretchActivity.EXTRA_RATIO, currentRatio().name)
                .putExtra(StretchActivity.EXTRA_FORCE_STOP, binding.forceStop.isChecked),
        )
    }

    private fun toast(message: String) {
        Toast.makeText(this, message, Toast.LENGTH_LONG).show()
    }

    companion object {
        const val ACTION_RESTORE = "com.kenmaster.displaystretch.RESTORE"
        private const val REQUEST_SHIZUKU = 1001
    }
}

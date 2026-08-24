package com.kenmaster.displaystretch

import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.os.Bundle
import android.view.LayoutInflater
import android.view.ViewGroup
import android.widget.Filter
import android.widget.Filterable
import androidx.appcompat.app.AppCompatActivity
import androidx.core.widget.doAfterTextChanged
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.kenmaster.displaystretch.databinding.ActivityAppPickerBinding
import com.kenmaster.displaystretch.databinding.ItemAppBinding

class AppPickerActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val binding = ActivityAppPickerBinding.inflate(layoutInflater)
        setContentView(binding.root)

        val apps = loadLaunchableApps()
        val adapter = AppAdapter(apps) { app ->
            setResult(
                RESULT_OK,
                intent
                    .putExtra(EXTRA_PACKAGE, app.packageName)
                    .putExtra(EXTRA_COMPONENT, app.component)
                    .putExtra(EXTRA_LABEL, app.label),
            )
            finish()
        }
        binding.appList.layoutManager = LinearLayoutManager(this)
        binding.appList.adapter = adapter
        binding.search.doAfterTextChanged { adapter.filter.filter(it?.toString().orEmpty()) }
    }

    private fun loadLaunchableApps(): List<LaunchableApp> {
        val pm = packageManager
        val intent = android.content.Intent(android.content.Intent.ACTION_MAIN)
            .addCategory(android.content.Intent.CATEGORY_LAUNCHER)
        val resolved = pm.queryIntentActivities(intent, PackageManager.MATCH_ALL)
        return resolved.map { info ->
            val appInfo = info.activityInfo.applicationInfo
            LaunchableApp(
                label = info.loadLabel(pm).toString(),
                packageName = info.activityInfo.packageName,
                component = android.content.ComponentName(
                    info.activityInfo.packageName,
                    info.activityInfo.name,
                ).flattenToString(),
                applicationInfo = appInfo,
            )
        }.distinctBy { it.packageName }
            .sortedWith(
                compareByDescending<LaunchableApp> { it.isLikelyGame }
                    .thenBy { it.label.lowercase() },
            )
    }

    data class LaunchableApp(
        val label: String,
        val packageName: String,
        val component: String,
        val applicationInfo: ApplicationInfo,
    ) {
        val isLikelyGame: Boolean
            get() {
                val text = (label + packageName).lowercase()
                return text.contains("无畏") ||
                    text.contains("valorant") ||
                    text.contains("val") && text.contains("tencent") ||
                    text.contains("tmgp")
            }
    }

    private inner class AppAdapter(
        private val source: List<LaunchableApp>,
        private val onClick: (LaunchableApp) -> Unit,
    ) : RecyclerView.Adapter<AppAdapter.Holder>(), Filterable {
        private var visible = source.toList()

        inner class Holder(val item: ItemAppBinding) : RecyclerView.ViewHolder(item.root)

        override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): Holder {
            val item = ItemAppBinding.inflate(LayoutInflater.from(parent.context), parent, false)
            return Holder(item)
        }

        override fun getItemCount(): Int = visible.size

        override fun onBindViewHolder(holder: Holder, position: Int) {
            val app = visible[position]
            holder.item.label.text = app.label
            holder.item.packageName.text = app.packageName
            holder.item.icon.setImageDrawable(packageManager.getApplicationIcon(app.applicationInfo))
            holder.item.root.setOnClickListener { onClick(app) }
        }

        override fun getFilter(): Filter = object : Filter() {
            override fun performFiltering(constraint: CharSequence?): FilterResults {
                val query = constraint?.toString()?.trim().orEmpty()
                val filtered = if (query.isEmpty()) {
                    source
                } else {
                    source.filter {
                        it.label.contains(query, true) || it.packageName.contains(query, true)
                    }
                }
                return FilterResults().apply {
                    values = filtered
                    count = filtered.size
                }
            }

            @Suppress("UNCHECKED_CAST")
            override fun publishResults(constraint: CharSequence?, results: FilterResults) {
                visible = results.values as List<LaunchableApp>
                notifyDataSetChanged()
            }
        }
    }

    companion object {
        const val EXTRA_PACKAGE = "package"
        const val EXTRA_COMPONENT = "component"
        const val EXTRA_LABEL = "label"
    }
}

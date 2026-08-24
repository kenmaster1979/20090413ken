package com.kenmaster.displaystretch

data class VirtualSize(
    val width: Int,
    val height: Int,
    val densityDpi: Int,
) {
    val label: String get() = "${width}x$height"
}

enum class StretchRatio {
    RATIO_4_3,
    RATIO_16_9,
}

object DisplayMath {
    fun virtualSize(
        physicalWidth: Int,
        physicalHeight: Int,
        densityDpi: Int,
        ratio: StretchRatio,
    ): VirtualSize {
        val landscapeW = maxOf(physicalWidth, physicalHeight)
        val landscapeH = minOf(physicalWidth, physicalHeight)
        val (targetW, targetH) = when (ratio) {
            StretchRatio.RATIO_4_3 -> 4 to 3
            StretchRatio.RATIO_16_9 -> 16 to 9
        }
        // Keep the physical height, shrink width so the compositor must stretch horizontally.
        var width = even((landscapeH * targetW + targetH / 2) / targetH)
        var height = even(landscapeH)
        if (width > landscapeW) {
            width = even(landscapeW)
            height = even((landscapeW * targetH + targetW / 2) / targetW)
        }
        return VirtualSize(width, height, densityDpi)
    }

    private fun even(value: Int): Int = value and 1.inv()
}

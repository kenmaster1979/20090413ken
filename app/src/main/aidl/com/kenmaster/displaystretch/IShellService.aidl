package com.kenmaster.displaystretch;

import android.view.Surface;

interface IShellService {
    void destroy() = 16777114;
    void exit() = 1;

    String getWmSize() = 2;
    String resetWmSize() = 3;

    int createVirtualDisplay(in Surface surface, int width, int height, int densityDpi) = 4;
    void releaseVirtualDisplay() = 5;
    String launchOnDisplay(String packageName, String componentFlattened, int displayId, boolean forceStop) = 6;

    boolean injectMotion(
            int displayId,
            long downTime,
            long eventTime,
            int action,
            int pointerCount,
            in int[] pointerIds,
            in float[] xs,
            in float[] ys,
            in float[] pressures,
            int metaState
    ) = 7;
}

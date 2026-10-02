package com.mangayomu.app;

import android.content.res.AssetManager;
import com.getcapacitor.Bridge;

/** Client-only APK: deliberately contains no embedded Node runtime. */
public final class ServerLauncher {
    private ServerLauncher() {}

    public static void startIfBundled(AssetManager assets, String filesDir) {
        // No-op by design.
    }

    public static void openHostedClientWhenReady(Bridge bridge) {
        // The client-only flavor remains on Capacitor's bundled static assets.
    }
}

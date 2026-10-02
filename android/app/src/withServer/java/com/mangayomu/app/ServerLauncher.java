package com.mangayomu.app;

import android.content.res.AssetManager;
import android.util.Log;
import com.getcapacitor.Bridge;

import java.net.HttpURLConnection;
import java.net.URL;

/** With-server APK: starts Node, then moves the WebView to Node's same-origin client. */
public final class ServerLauncher {
    private static final String TAG = "ServerLauncher";
    private static final String SERVER_ORIGIN = "http://127.0.0.1:4567";
    private static final int MAX_HEALTH_ATTEMPTS = 80;
    private static final int RETRY_DELAY_MS = 150;

    private ServerLauncher() {}

    public static void startIfBundled(AssetManager assets, String filesDir) {
        NodeRunner.startServer(assets, filesDir);
    }

    public static void openHostedClientWhenReady(final Bridge bridge) {
        new Thread(() -> {
            for (int attempt = 0; attempt < MAX_HEALTH_ATTEMPTS; attempt++) {
                if (serverIsReady()) {
                    bridge.getWebView().post(() -> bridge.getWebView().loadUrl(SERVER_ORIGIN + "/"));
                    return;
                }
                try {
                    Thread.sleep(RETRY_DELAY_MS);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    return;
                }
            }
            // Keep the Capacitor asset client visible if Node could not start.
            Log.e(TAG, "Embedded server did not become ready; keeping bundled client");
        }, "mangayomu-server-health").start();
    }

    private static boolean serverIsReady() {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) new URL(SERVER_ORIGIN + "/api/health").openConnection();
            connection.setRequestMethod("GET");
            connection.setConnectTimeout(300);
            connection.setReadTimeout(300);
            return connection.getResponseCode() == 200;
        } catch (Exception ignored) {
            return false;
        } finally {
            if (connection != null) connection.disconnect();
        }
    }
}

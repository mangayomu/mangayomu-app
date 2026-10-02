package com.mangayomu.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Start Node first. The withServer launcher redirects the WebView only
        // after the same-origin Node server answers its health check.
        ServerLauncher.startIfBundled(getAssets(), getFilesDir().getAbsolutePath());
        super.onCreate(savedInstanceState);
        registerPlugin(ScreenAwakePlugin.class);
        ServerLauncher.openHostedClientWhenReady(getBridge());
    }
}

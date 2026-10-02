package com.mangayomu.app;

import android.content.res.AssetManager;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * Starts the embedded Node.js runtime in a background thread.
 * The native library calls node::Start() which blocks — hence the thread.
 */
public class NodeRunner {

    private static final String TAG = "NodeRunner";
    private static final String NODE_PROJECT_ASSET = "nodejs-project";
    private static final String NODE_PROJECT_DIR = "nodejs-project";
    private static final String DATA_DIR = "mangayomu-data";
    private static final String DATABASE_FILE = "mangayomu.db";
    private static final String BUNDLE_VERSION_FILE = "bundle-version.txt";
    private static final int SERVER_PORT = 4567;

    static {
        System.loadLibrary("native-lib");
    }

    private static native int nativeStartNode(String[] arguments);

    /**
     * Start the Node.js server. Copies the project from APK assets to
     * internal storage (Node cannot read compressed assets directly),
     * then launches the runtime in a background thread.
     */
    public static void startServer(final AssetManager assetManager, final String filesDir) {
        final Thread thread = new Thread(() -> {
            try {
                // Keep user data outside the extracted asset tree. Re-extract
                // Node assets only when the APK bundle changed: copying the full
                // dependency tree on every app launch delays server startup.
                final File nodeDir = new File(filesDir, NODE_PROJECT_DIR);
                final File dataDir = new File(filesDir, DATA_DIR);
                final String assetVersion = readAssetText(assetManager,
                        NODE_PROJECT_ASSET + "/" + BUNDLE_VERSION_FILE);
                final String installedVersion = readFileText(new File(nodeDir, BUNDLE_VERSION_FILE));
                if (!assetVersion.equals(installedVersion)) {
                    migrateLegacyDatabase(nodeDir, dataDir);
                    deleteDirectory(nodeDir);
                    copyAssetDirectory(assetManager, NODE_PROJECT_ASSET, nodeDir);
                }

                final File mainScript = new File(nodeDir, "src/index.js");
                if (!mainScript.exists()) {
                    Log.e(TAG, "Main script not found: " + mainScript.getAbsolutePath());
                    return;
                }

                // Build argv: node <script>
                final String[] argv = {
                        "node",
                        mainScript.getAbsolutePath(),
                        "--port", String.valueOf(SERVER_PORT)
                };

                Log.i(TAG, "Starting Node.js server on port " + SERVER_PORT + "...");
                nativeStartNode(argv);
                Log.w(TAG, "Node.js exited (unexpected)");
            } catch (Exception e) {
                Log.e(TAG, "Failed to start Node.js server", e);
            }
        });
        thread.setName("node-engine");
        thread.start();
    }

    // ---- asset helpers ----

    private static String readAssetText(AssetManager assets, String assetPath) throws Exception {
        try (InputStream in = assets.open(assetPath)) {
            return readText(in);
        }
    }

    private static String readFileText(File file) throws Exception {
        if (!file.exists()) return "";
        try (InputStream in = new FileInputStream(file)) {
            return readText(in);
        }
    }

    private static String readText(InputStream in) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[1024];
        int len;
        while ((len = in.read(buf)) > 0) {
            out.write(buf, 0, len);
        }
        return out.toString("UTF-8").trim();
    }

    private static void migrateLegacyDatabase(File nodeDir, File dataDir) throws Exception {
        final File legacyDatabase = new File(new File(nodeDir, "src"), DATABASE_FILE);
        final File database = new File(dataDir, DATABASE_FILE);
        if (!legacyDatabase.exists() || database.exists()) return;

        if (!dataDir.exists() && !dataDir.mkdirs()) {
            throw new RuntimeException("Cannot create data directory: " + dataDir);
        }

        final File temporaryDatabase = new File(dataDir, DATABASE_FILE + ".tmp");
        try (InputStream in = new FileInputStream(legacyDatabase);
             FileOutputStream out = new FileOutputStream(temporaryDatabase)) {
            byte[] buf = new byte[8192];
            int len;
            while ((len = in.read(buf)) > 0) {
                out.write(buf, 0, len);
            }
            out.getFD().sync();
        }

        if (!temporaryDatabase.renameTo(database)) {
            temporaryDatabase.delete();
            throw new RuntimeException("Cannot move migrated database to: " + database);
        }
    }

    private static void deleteDirectory(File dir) {
        if (dir == null || !dir.exists()) return;
        final File[] children = dir.listFiles();
        if (children != null) {
            for (File child : children) {
                if (child.isDirectory()) {
                    deleteDirectory(child);
                }
                child.delete();
            }
        }
        dir.delete();
    }

    private static void copyAssetDirectory(AssetManager assets, String assetPath, File destDir) throws Exception {
        final String[] children = assets.list(assetPath);
        if (children == null) return;

        if (children.length == 0) {
            // It's a file
            copyAssetFile(assets, assetPath, destDir);
            return;
        }

        // It's a directory
        if (!destDir.exists() && !destDir.mkdirs()) {
            throw new RuntimeException("Cannot create dir: " + destDir);
        }

        for (String child : children) {
            final String childAsset = assetPath.isEmpty() ? child : assetPath + "/" + child;
            final File childDest = new File(destDir, child);
            copyAssetDirectory(assets, childAsset, childDest);
        }
    }

    private static void copyAssetFile(AssetManager assets, String assetPath, File destFile) throws Exception {
        destFile.getParentFile().mkdirs();
        try (InputStream in = assets.open(assetPath);
             OutputStream out = new FileOutputStream(destFile)) {
            byte[] buf = new byte[8192];
            int len;
            while ((len = in.read(buf)) > 0) {
                out.write(buf, 0, len);
            }
        }
    }
}

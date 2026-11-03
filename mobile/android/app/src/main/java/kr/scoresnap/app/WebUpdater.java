package kr.scoresnap.app;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import com.getcapacitor.Bridge;
import com.getcapacitor.JSObject;

import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.ConnectException;
import java.net.HttpURLConnection;
import java.net.SocketTimeoutException;
import java.net.URL;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * Over-the-air web-bundle updater (SPEC §7, Android).
 *
 * <pre>
 *   UPDATE_BASE_URL/version.json  →  { version, web:{bundle, sha256}, android:{apk, apkUrl, minNative}, notes }
 *   newer than the active bundle  →  download web/<bundle> zip → verify SHA-256 → unzip into
 *   files/bundles/<version>/      →  (persist) → bridge.setServerBasePath(dir) → WebView reloads
 * </pre>
 *
 * How the switched bundle survives a restart: Capacitor's {@code Bridge} reads
 * SharedPreferences {@code CapWebViewSettings/serverBasePath} when it starts (that is what the
 * core {@code WebView.persistServerBasePath()} JS API writes) and serves from that folder if it
 * exists. We write the same key natively.  As a belt-and-braces measure
 * {@link #ensureActiveBundle(Context, Bridge)} runs in {@code MainActivity.onCreate()} after the
 * bridge was created: if the newest valid bundle is newer than the packaged web app but is not
 * the one being served, it is applied (one extra reload); if the packaged app is newer (APK was
 * updated), stale bundles and the persisted path are removed.
 *
 * Status objects follow SPEC §6 UpdateStatus and are delivered through {@link StatusSink}
 * (the plugin forwards them with notifyListeners("updateStatus", …)).
 */
public final class WebUpdater {

    public interface StatusSink {
        void onStatus(JSObject status);
    }

    public interface Result {
        void ok();
        void fail(String message);
    }

    private static final String TAG = "JSEUpdater";

    static final String PREFS = "scoresnap_update";
    static final String KEY_AUTO = "auto";
    static final String KEY_WIFI_ONLY = "wifiOnly";
    static final String KEY_LAST_CHECK = "lastCheckAt";
    static final String KEY_PENDING_DONE = "pendingDoneVersion";
    static final String KEY_READY_VERSION = "readyVersion";
    static final String KEY_READY_PATH = "readyPath";
    static final String KEY_ACTIVE_PATH = "activeBundlePath";
    static final String KEY_ACTIVE_VERSION = "activeBundleVersion";

    /** Capacitor core: com.getcapacitor.plugin.WebView.WEBVIEW_PREFS_NAME / CAP_SERVER_PATH. */
    static final String CAP_PREFS = "CapWebViewSettings";
    static final String CAP_KEY_SERVER_PATH = "serverBasePath";
    /** Capacitor's default asset folder (Bridge.DEFAULT_WEB_ASSET_DIR). */
    static final String CAP_ASSET_DIR = "public";

    private static final String BUNDLES_DIR = "bundles";
    private static final String PLACEHOLDER = "REPLACE_GITHUB_OWNER";
    static final long CHECK_INTERVAL_MS = 4L * 60 * 60 * 1000;
    private static final long MAX_ZIP_BYTES = 200L * 1024 * 1024;
    private static final long MAX_UNZIPPED_BYTES = 600L * 1024 * 1024;
    private static final int KEEP_BUNDLES = 2;
    private static final int CONNECT_TIMEOUT_MS = 15000;
    private static final int READ_TIMEOUT_MS = 30000;

    private final Context ctx;
    private final Bridge bridge;
    private final StatusSink sink;
    private final String nativeVersion;
    private final String baseUrl;
    private final ExecutorService exec = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());

    private volatile boolean busy = false;
    private volatile JSObject lastStatus = null;
    private final Object manifestLock = new Object();
    private JSONObject lastManifest = null;

    public WebUpdater(Context context, Bridge bridge, String nativeVersion, StatusSink sink) {
        this.ctx = context.getApplicationContext();
        this.bridge = bridge;
        this.sink = sink;
        this.nativeVersion = nativeVersion == null ? "0.0.0" : nativeVersion;
        String url = this.ctx.getString(R.string.update_base_url).trim();
        if (!url.endsWith("/")) url = url + "/";
        this.baseUrl = url;
    }

    /* ------------------------------------------------------------------ public API */

    public boolean isConfigured() {
        return !baseUrl.contains(PLACEHOLDER) && baseUrl.startsWith("http");
    }

    public String getBaseUrl() {
        return baseUrl;
    }

    public JSObject getLastStatus() {
        return lastStatus;
    }

    public JSObject getSettings() {
        SharedPreferences p = prefs(ctx);
        JSObject o = new JSObject();
        o.put("auto", p.getBoolean(KEY_AUTO, true));
        o.put("wifiOnly", p.getBoolean(KEY_WIFI_ONLY, false));
        o.put("channel", "stable");
        o.put("url", baseUrl);
        return o;
    }

    public void setSettings(JSObject partial) {
        if (partial == null) return;
        SharedPreferences.Editor e = prefs(ctx).edit();
        if (partial.has("auto")) e.putBoolean(KEY_AUTO, partial.optBoolean("auto", true));
        if (partial.has("wifiOnly")) e.putBoolean(KEY_WIFI_ONLY, partial.optBoolean("wifiOnly", false));
        e.apply();
        if (partial.has("auto") && partial.optBoolean("auto", true)) checkAsync(false);
    }

    /** Called on app start / resume; respects the auto setting and the check interval. */
    public void checkIfDue() {
        if (!prefs(ctx).getBoolean(KEY_AUTO, true)) return;
        long last = prefs(ctx).getLong(KEY_LAST_CHECK, 0L);
        if (System.currentTimeMillis() - last < CHECK_INTERVAL_MS) return;
        checkAsync(false);
    }

    /**
     * Check (and, when auto is on, download + prepare) in the background.
     * @param manual true when the user asked (always reports a status, ignores the interval)
     */
    public void checkAsync(final boolean manual) {
        if (!isConfigured()) {
            Log.i(TAG, "update_base_url is not configured (" + baseUrl + "); skipping update check");
            if (manual) emit(status("idle"));
            return;
        }
        if (busy) {
            if (manual && lastStatus != null) emit(lastStatus);
            return;
        }
        boolean wifiOnly = prefs(ctx).getBoolean(KEY_WIFI_ONLY, false);
        if (!isOnline(ctx, !manual && wifiOnly)) {
            if (manual) emit(error("인터넷에 연결되어 있지 않습니다."));
            return;
        }
        busy = true;
        exec.execute(() -> {
            try {
                runCheck(manual);
            } catch (Exception e) {
                Log.w(TAG, "update check failed", e);
                emit(error(friendly(e)));
            } finally {
                busy = false;
            }
        });
    }

    /** Apply a prepared bundle now, or download first, or open the APK page. */
    public void installUpdate(final Result result) {
        SharedPreferences p = prefs(ctx);
        String readyVersion = p.getString(KEY_READY_VERSION, null);
        String readyPath = p.getString(KEY_READY_PATH, null);
        if (readyVersion != null && isValidBundleDir(readyPath)) {
            applyBundle(readyPath, readyVersion);
            result.ok();
            return;
        }

        final JSONObject manifest;
        synchronized (manifestLock) {
            manifest = lastManifest;
        }
        if (manifest != null) {
            if (needsNativeUpdate(manifest)) {
                String apk = apkUrl(manifest);
                if (apk != null) {
                    openUrl(apk);
                    result.ok();
                    return;
                }
                result.fail("새 버전은 앱(APK) 자체를 다시 설치해야 합니다.");
                return;
            }
            if (busy) {
                result.ok(); // already downloading; statuses keep flowing
                return;
            }
            busy = true;
            exec.execute(() -> {
                try {
                    String path = downloadAndPrepare(manifest);
                    applyBundle(path, manifest.optString("version", ""));
                } catch (Exception e) {
                    Log.w(TAG, "install failed", e);
                    emit(error(friendly(e)));
                } finally {
                    busy = false;
                }
            });
            result.ok();
            return;
        }
        result.fail("설치할 업데이트가 없습니다. 먼저 업데이트를 확인해 주세요.");
    }

    /**
     * {state:'done', version} exactly once after a new bundle became active (consumed), else null.
     */
    public JSObject consumeStartupStatus() {
        SharedPreferences p = prefs(ctx);
        String pending = p.getString(KEY_PENDING_DONE, null);
        if (pending == null) return null;
        String active = activeVersion(ctx, bridge);
        if (pending.equals(active)) {
            p.edit().remove(KEY_PENDING_DONE).apply();
            return withVersion("done", pending);
        }
        if (Semver.compare(active, pending) > 0) {
            p.edit().remove(KEY_PENDING_DONE).apply();
        }
        return null;
    }

    public void shutdown() {
        exec.shutdownNow();
    }

    /* ------------------------------------------------------------------ check / download */

    private void runCheck(boolean manual) throws Exception {
        prefs(ctx).edit().putLong(KEY_LAST_CHECK, System.currentTimeMillis()).apply();
        emit(status("checking"));

        JSONObject manifest = fetchManifest();
        synchronized (manifestLock) {
            lastManifest = manifest;
        }
        String remote = manifest.optString("version", "").trim();
        String active = activeVersion(ctx, bridge);
        if (!Semver.isValid(remote) || Semver.compare(remote, active) <= 0) {
            emit(withVersion("up-to-date", active));
            return;
        }

        SharedPreferences p = prefs(ctx);
        String readyVersion = p.getString(KEY_READY_VERSION, null);
        String readyPath = p.getString(KEY_READY_PATH, null);
        if (remote.equals(readyVersion) && isValidBundleDir(readyPath)) {
            emit(withVersion("ready", remote));
            return;
        }

        JSObject available = withVersion("available", remote);
        available.put("notes", manifest.optString("notes", ""));
        if (needsNativeUpdate(manifest)) {
            available.put("requiresNative", true);
            available.put("minNative", minNative(manifest));
            String apk = apkUrl(manifest);
            if (apk != null) available.put("apkUrl", apk);
            emit(available);
            return;
        }
        emit(available);

        if (p.getBoolean(KEY_AUTO, true)) {
            downloadAndPrepare(manifest);
            // Stays "ready": the web app decides when to reload (installUpdate at a safe moment).
            // If it never does, the persisted path makes the next cold start use the new bundle.
        }
    }

    private JSONObject fetchManifest() throws IOException {
        String url = baseUrl + "version.json?t=" + System.currentTimeMillis();
        HttpURLConnection c = open(url);
        try {
            int code = c.getResponseCode();
            if (code != HttpURLConnection.HTTP_OK) throw new IOException("HTTP " + code);
            byte[] body = readAll(c.getInputStream(), 1024 * 1024);
            return new JSONObject(new String(body, StandardCharsets.UTF_8));
        } catch (org.json.JSONException e) {
            throw new IOException("version.json 형식 오류", e);
        } finally {
            c.disconnect();
        }
    }

    /** Downloads, verifies and unzips the bundle; returns the bundle directory path. */
    private String downloadAndPrepare(JSONObject manifest) throws Exception {
        final String version = manifest.optString("version", "").trim();
        JSONObject web = manifest.optJSONObject("web");
        if (!Semver.isValid(version) || web == null) throw new IOException("version.json에 web 번들 정보가 없습니다");
        String bundle = web.optString("bundle", "").trim();
        String sha = web.optString("sha256", "").trim().toLowerCase(Locale.ROOT);
        if (bundle.isEmpty()) throw new IOException("version.json에 web.bundle 이 없습니다");

        File cacheDir = new File(ctx.getCacheDir(), "ota");
        //noinspection ResultOfMethodCallIgnored
        cacheDir.mkdirs();
        File zip = new File(cacheDir, "web-" + safeName(version) + ".zip");

        boolean reuse = zip.isFile() && !sha.isEmpty() && sha.equals(sha256(zip));
        if (!reuse) {
            download(resolveUrl(bundle), zip, version);
            if (!sha.isEmpty()) {
                String actual = sha256(zip);
                if (!sha.equals(actual)) {
                    //noinspection ResultOfMethodCallIgnored
                    zip.delete();
                    throw new IOException("checksum mismatch");
                }
            }
        }

        File bundlesRoot = new File(ctx.getFilesDir(), BUNDLES_DIR);
        //noinspection ResultOfMethodCallIgnored
        bundlesRoot.mkdirs();
        File target = new File(bundlesRoot, safeName(version));
        File tmp = new File(bundlesRoot, safeName(version) + ".tmp");
        deleteRecursive(tmp);
        deleteRecursive(target);

        unzip(zip, tmp);
        File root = findWebRoot(tmp);
        if (root == null) {
            deleteRecursive(tmp);
            throw new IOException("번들에 index.html 이 없습니다");
        }
        if (!root.equals(tmp)) {
            // zip had a single top-level folder: hoist it
            File moved = new File(bundlesRoot, safeName(version) + ".mv");
            deleteRecursive(moved);
            if (!root.renameTo(moved)) throw new IOException("번들 폴더를 옮기지 못했습니다");
            deleteRecursive(tmp);
            tmp = moved;
        }
        ensureVersionJson(tmp, version);
        if (!tmp.renameTo(target)) throw new IOException("번들 폴더를 만들지 못했습니다");
        //noinspection ResultOfMethodCallIgnored
        zip.delete();

        String path = target.getAbsolutePath();
        prefs(ctx).edit()
            .putString(KEY_READY_VERSION, version)
            .putString(KEY_READY_PATH, path)
            .putString(KEY_PENDING_DONE, version)
            .apply();
        // Next cold start serves the new bundle even if the page is never reloaded in this session.
        persistCapacitorPath(ctx, path);
        cleanupOldBundles(bundlesRoot, target);
        emit(withVersion("ready", version));
        return path;
    }

    private void download(String url, File dest, String version) throws IOException {
        File part = new File(dest.getAbsolutePath() + ".part");
        HttpURLConnection c = open(url);
        try {
            int code = c.getResponseCode();
            if (code != HttpURLConnection.HTTP_OK) throw new IOException("HTTP " + code);
            long total = c.getContentLengthLong();
            if (total > MAX_ZIP_BYTES) throw new IOException("번들이 너무 큽니다");
            emit(progress(version, 0));
            long done = 0;
            int lastPercent = -1;
            long lastEmit = 0;
            byte[] buf = new byte[64 * 1024];
            try (InputStream in = new BufferedInputStream(c.getInputStream());
                 OutputStream out = new FileOutputStream(part)) {
                int n;
                while ((n = in.read(buf)) > 0) {
                    out.write(buf, 0, n);
                    done += n;
                    if (done > MAX_ZIP_BYTES) throw new IOException("번들이 너무 큽니다");
                    int percent = total > 0 ? (int) Math.min(99, done * 100 / total) : 0;
                    long now = System.currentTimeMillis();
                    if (percent != lastPercent && now - lastEmit > 250) {
                        lastPercent = percent;
                        lastEmit = now;
                        emit(progress(version, percent));
                    }
                }
            }
            if (total > 0 && done != total) throw new IOException("download incomplete");
            //noinspection ResultOfMethodCallIgnored
            dest.delete();
            if (!part.renameTo(dest)) throw new IOException("다운로드 파일을 저장하지 못했습니다");
            emit(progress(version, 100));
        } finally {
            c.disconnect();
            //noinspection ResultOfMethodCallIgnored
            part.delete();
        }
    }

    private HttpURLConnection open(String url) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(CONNECT_TIMEOUT_MS);
        c.setReadTimeout(READ_TIMEOUT_MS);
        c.setInstanceFollowRedirects(true);
        c.setUseCaches(false);
        c.setRequestProperty("Cache-Control", "no-cache");
        c.setRequestProperty("User-Agent", "JSE-Android/" + nativeVersion);
        return c;
    }

    /* ------------------------------------------------------------------ apply */

    private void applyBundle(final String path, final String version) {
        prefs(ctx).edit()
            .putString(KEY_PENDING_DONE, version)
            .putString(KEY_ACTIVE_PATH, path)
            .putString(KEY_ACTIVE_VERSION, version)
            .remove(KEY_READY_VERSION)
            .remove(KEY_READY_PATH)
            .apply();
        persistCapacitorPath(ctx, path);
        main.post(() -> {
            try {
                bridge.getWebView().clearCache(true);
            } catch (Exception ignored) {
                // cache clearing is best effort
            }
            // Re-points Capacitor's local server at the folder and reloads the WebView.
            bridge.setServerBasePath(path);
        });
    }

    /**
     * Run once from MainActivity.onCreate() AFTER super.onCreate() (the bridge must exist).
     * Makes sure the served web app is the newest valid one (bundle or packaged).
     */
    public static void ensureActiveBundle(Context context, Bridge bridge) {
        final Context ctx = context.getApplicationContext();
        try {
            SharedPreferences p = prefs(ctx);
            String packaged = packagedVersion(ctx);
            String readyPath = p.getString(KEY_READY_PATH, null);
            String readyVersion = p.getString(KEY_READY_VERSION, null);
            String activePath = p.getString(KEY_ACTIVE_PATH, null);

            String candidatePath = null;
            String candidateVersion = null;
            if (readyVersion != null && isValidBundleDir(readyPath) && Semver.compare(readyVersion, packaged) > 0) {
                candidatePath = readyPath;
                candidateVersion = readyVersion;
            } else if (isValidBundleDir(activePath)) {
                String v = readVersion(new File(activePath, "version.json"));
                if (v != null && Semver.compare(v, packaged) > 0) {
                    candidatePath = activePath;
                    candidateVersion = v;
                }
            }

            String current = currentServerPath(bridge);

            if (candidatePath == null) {
                // Packaged web app is the newest → serve assets, forget bundles.
                if (readyPath != null || activePath != null) {
                    p.edit().remove(KEY_READY_PATH).remove(KEY_READY_VERSION)
                        .remove(KEY_ACTIVE_PATH).remove(KEY_ACTIVE_VERSION).apply();
                }
                SharedPreferences cap = ctx.getSharedPreferences(CAP_PREFS, Context.MODE_PRIVATE);
                String capPath = cap.getString(CAP_KEY_SERVER_PATH, null);
                if (capPath != null) {
                    String v = isValidBundleDir(capPath) ? readVersion(new File(capPath, "version.json")) : null;
                    if (v == null || Semver.compare(v, packaged) <= 0) {
                        cap.edit().remove(CAP_KEY_SERVER_PATH).apply();
                        if (current != null && current.startsWith("/")) {
                            Log.i(TAG, "packaged web app is newer than bundle " + current + " → serving assets");
                            bridge.setServerAssetPath(CAP_ASSET_DIR);
                        }
                    }
                }
                new Thread(() -> deleteStaleBundles(ctx, packaged, null), "ssnap-bundle-gc").start();
                return;
            }

            if (readyPath != null && readyPath.equals(candidatePath)) {
                // Prepared earlier but never applied in-session: it becomes active now.
                p.edit().remove(KEY_READY_PATH).remove(KEY_READY_VERSION)
                    .putString(KEY_ACTIVE_PATH, candidatePath)
                    .putString(KEY_ACTIVE_VERSION, candidateVersion)
                    .putString(KEY_PENDING_DONE, candidateVersion)
                    .apply();
            }
            if (!candidatePath.equals(current)) {
                Log.i(TAG, "activating bundle " + candidateVersion + " at " + candidatePath + " (was " + current + ")");
                persistCapacitorPath(ctx, candidatePath);
                bridge.setServerBasePath(candidatePath);
            }
            final String keep = candidatePath;
            new Thread(() -> deleteStaleBundles(ctx, packaged, keep), "ssnap-bundle-gc").start();
        } catch (Exception e) {
            Log.w(TAG, "ensureActiveBundle failed", e);
        }
    }

    /* ------------------------------------------------------------------ version helpers */

    /** Version of the web app that is currently being served (bundle or packaged). */
    public static String activeVersion(Context context, Bridge bridge) {
        String current = currentServerPath(bridge);
        if (current != null && current.startsWith("/")) {
            String v = readVersion(new File(current, "version.json"));
            if (v != null) return v;
        }
        return packagedVersion(context);
    }

    /** Version of the web app inside the APK (assets/public/version.json). */
    public static String packagedVersion(Context context) {
        try (InputStream in = context.getAssets().open(CAP_ASSET_DIR + "/version.json")) {
            JSONObject o = new JSONObject(new String(readAll(in, 64 * 1024), StandardCharsets.UTF_8));
            String v = o.optString("version", "").trim();
            return Semver.isValid(v) ? v : "0.0.0";
        } catch (Exception e) {
            return "0.0.0";
        }
    }

    private static String currentServerPath(Bridge bridge) {
        if (bridge == null) return null;
        try {
            return bridge.getServerBasePath();
        } catch (Exception e) {
            return null;
        }
    }

    private static String readVersion(File versionJson) {
        if (versionJson == null || !versionJson.isFile()) return null;
        try (InputStream in = new FileInputStream(versionJson)) {
            JSONObject o = new JSONObject(new String(readAll(in, 64 * 1024), StandardCharsets.UTF_8));
            String v = o.optString("version", "").trim();
            return Semver.isValid(v) ? v : null;
        } catch (Exception e) {
            return null;
        }
    }

    private static void ensureVersionJson(File dir, String version) {
        File f = new File(dir, "version.json");
        if (readVersion(f) != null) return;
        try (OutputStream out = new FileOutputStream(f)) {
            out.write(("{\"version\":\"" + version + "\"}").getBytes(StandardCharsets.UTF_8));
        } catch (IOException e) {
            Log.w(TAG, "could not write version.json", e);
        }
    }

    static boolean isValidBundleDir(String path) {
        if (path == null || path.isEmpty()) return false;
        File dir = new File(path);
        return dir.isDirectory() && new File(dir, "index.html").isFile();
    }

    private static void persistCapacitorPath(Context ctx, String path) {
        ctx.getSharedPreferences(CAP_PREFS, Context.MODE_PRIVATE)
            .edit().putString(CAP_KEY_SERVER_PATH, path).apply();
    }

    private boolean needsNativeUpdate(JSONObject manifest) {
        String min = minNative(manifest);
        return !min.isEmpty() && Semver.isValid(min) && Semver.compare(min, nativeVersion) > 0;
    }

    private static String minNative(JSONObject manifest) {
        JSONObject android = manifest.optJSONObject("android");
        return android == null ? "" : android.optString("minNative", "").trim();
    }

    private String apkUrl(JSONObject manifest) {
        JSONObject android = manifest.optJSONObject("android");
        if (android == null) return null;
        String url = android.optString("apkUrl", "").trim();
        if (url.isEmpty()) url = android.optString("apk", "").trim();
        if (url.isEmpty()) return null;
        return resolveUrl(url);
    }

    private String resolveUrl(String s) {
        if (s.startsWith("http://") || s.startsWith("https://")) return s;
        if (s.startsWith("/")) s = s.substring(1);
        return baseUrl + s;
    }

    private void openUrl(String url) {
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            ctx.startActivity(i);
        } catch (Exception e) {
            Log.w(TAG, "openUrl failed", e);
        }
    }

    /* ------------------------------------------------------------------ bundle housekeeping */

    /** Keep the current bundle plus at most KEEP_BUNDLES newest ones. */
    private static void cleanupOldBundles(File bundlesRoot, File keep) {
        File[] dirs = bundlesRoot.listFiles();
        if (dirs == null) return;
        List<File> versions = new ArrayList<>();
        for (File d : dirs) {
            if (!d.isDirectory()) continue;
            if (d.getName().endsWith(".tmp") || d.getName().endsWith(".mv")) {
                deleteRecursive(d);
                continue;
            }
            versions.add(d);
        }
        Collections.sort(versions, (a, b) -> Semver.compare(b.getName(), a.getName())); // newest first
        int kept = 0;
        for (File d : versions) {
            if (d.equals(keep) || kept < KEEP_BUNDLES) {
                kept++;
                continue;
            }
            deleteRecursive(d);
        }
    }

    /** Delete bundles that are not newer than the packaged web app (except {@code keepPath}). */
    private static void deleteStaleBundles(Context ctx, String packaged, String keepPath) {
        File root = new File(ctx.getFilesDir(), BUNDLES_DIR);
        File[] dirs = root.listFiles();
        if (dirs == null) return;
        for (File d : dirs) {
            if (!d.isDirectory()) continue;
            if (keepPath != null && d.getAbsolutePath().equals(keepPath)) continue;
            String v = readVersion(new File(d, "version.json"));
            if (v == null || Semver.compare(v, packaged) <= 0 || d.getName().endsWith(".tmp") || d.getName().endsWith(".mv")) {
                deleteRecursive(d);
            }
        }
    }

    /* ------------------------------------------------------------------ zip / io */

    private static void unzip(File zip, File targetDir) throws IOException {
        //noinspection ResultOfMethodCallIgnored
        targetDir.mkdirs();
        String rootCanonical = targetDir.getCanonicalPath() + File.separator;
        long totalOut = 0;
        byte[] buf = new byte[64 * 1024];
        try (ZipInputStream zis = new ZipInputStream(new BufferedInputStream(new FileInputStream(zip)))) {
            ZipEntry entry;
            while ((entry = zis.getNextEntry()) != null) {
                String name = entry.getName();
                if (name.startsWith("__MACOSX/") || name.endsWith(".DS_Store")) {
                    zis.closeEntry();
                    continue;
                }
                File out = new File(targetDir, name);
                String canonical = out.getCanonicalPath();
                if (!canonical.startsWith(rootCanonical)) {
                    throw new IOException("zip entry outside target (zip-slip): " + name); // reject ../ paths
                }
                if (entry.isDirectory()) {
                    //noinspection ResultOfMethodCallIgnored
                    out.mkdirs();
                    zis.closeEntry();
                    continue;
                }
                File parent = out.getParentFile();
                if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
                    throw new IOException("cannot create " + parent);
                }
                try (OutputStream fos = new FileOutputStream(out)) {
                    int n;
                    while ((n = zis.read(buf)) > 0) {
                        fos.write(buf, 0, n);
                        totalOut += n;
                        if (totalOut > MAX_UNZIPPED_BYTES) throw new IOException("bundle too large");
                    }
                }
                zis.closeEntry();
            }
        }
    }

    /** index.html at the root, or inside a single top-level folder. */
    private static File findWebRoot(File dir) {
        if (new File(dir, "index.html").isFile()) return dir;
        File[] children = dir.listFiles();
        if (children == null) return null;
        File onlyDir = null;
        int dirs = 0;
        for (File c : children) {
            if (c.isDirectory()) {
                dirs++;
                onlyDir = c;
            } else {
                return null; // loose files next to a folder: not a plain bundle
            }
        }
        if (dirs == 1 && onlyDir != null && new File(onlyDir, "index.html").isFile()) return onlyDir;
        return null;
    }

    static void deleteRecursive(File f) {
        if (f == null || !f.exists()) return;
        File[] children = f.listFiles();
        if (children != null) {
            for (File c : children) deleteRecursive(c);
        }
        //noinspection ResultOfMethodCallIgnored
        f.delete();
    }

    private static String sha256(File f) throws IOException {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] buf = new byte[64 * 1024];
            try (InputStream in = new BufferedInputStream(new FileInputStream(f))) {
                int n;
                while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
            }
            StringBuilder sb = new StringBuilder();
            for (byte b : md.digest()) sb.append(String.format(Locale.ROOT, "%02x", b));
            return sb.toString();
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IOException(e);
        }
    }

    static byte[] readAll(InputStream in, long max) throws IOException {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[64 * 1024];
        long total = 0;
        int n;
        while ((n = in.read(buf)) > 0) {
            total += n;
            if (total > max) throw new IOException("too large (max " + max + " bytes)");
            bos.write(buf, 0, n);
        }
        return bos.toByteArray();
    }

    private static String safeName(String s) {
        return s.replaceAll("[^0-9A-Za-z._-]", "_");
    }

    /* ------------------------------------------------------------------ network */

    static boolean isOnline(Context ctx, boolean wifiOnly) {
        try {
            ConnectivityManager cm = (ConnectivityManager) ctx.getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) return true;
            Network n = cm.getActiveNetwork();
            if (n == null) return false;
            NetworkCapabilities caps = cm.getNetworkCapabilities(n);
            if (caps == null) return false;
            if (!caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)) return false;
            if (wifiOnly) {
                return caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
                    || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET);
            }
            return true;
        } catch (Exception e) {
            return true; // no permission / odd device: let the request decide
        }
    }

    /* ------------------------------------------------------------------ status objects */

    private void emit(final JSObject status) {
        lastStatus = status;
        if (sink == null) return;
        if (Looper.myLooper() == Looper.getMainLooper()) {
            sink.onStatus(status);
        } else {
            main.post(() -> sink.onStatus(status));
        }
    }

    static JSObject status(String state) {
        JSObject o = new JSObject();
        o.put("state", state);
        return o;
    }

    static JSObject withVersion(String state, String version) {
        JSObject o = status(state);
        o.put("version", version == null ? "" : version);
        return o;
    }

    static JSObject progress(String version, int percent) {
        JSObject o = withVersion("downloading", version);
        o.put("percent", percent);
        return o;
    }

    static JSObject error(String message) {
        JSObject o = status("error");
        o.put("message", message);
        return o;
    }

    static String friendly(Exception e) {
        if (e instanceof UnknownHostException || e instanceof ConnectException || e instanceof SocketTimeoutException) {
            return "업데이트 서버에 연결할 수 없습니다. 나중에 다시 시도합니다.";
        }
        String m = e.getMessage() == null ? "" : e.getMessage();
        if (m.startsWith("HTTP 404")) return "업데이트 정보를 찾을 수 없습니다 (404).";
        if (m.startsWith("HTTP ")) return "업데이트 서버 오류 (" + m + ").";
        if (m.contains("checksum")) return "다운로드한 업데이트 파일이 손상되었습니다 (체크섬 불일치).";
        if (m.contains("too large") || m.contains("너무 큽니다")) return "업데이트 파일이 너무 큽니다.";
        if (m.contains("ENOSPC") || m.contains("No space")) return "저장 공간이 부족합니다.";
        return "업데이트 중 오류가 발생했습니다" + (m.isEmpty() ? "." : ": " + m);
    }

    static SharedPreferences prefs(Context ctx) {
        return ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}

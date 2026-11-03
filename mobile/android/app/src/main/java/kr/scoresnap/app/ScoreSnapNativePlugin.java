package kr.scoresnap.app;

import android.Manifest;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.media.MediaScannerConnection;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.util.Log;
import android.webkit.MimeTypeMap;

import androidx.annotation.RequiresApi;
import androidx.core.content.FileProvider;

import com.getcapacitor.Bridge;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Locale;

/**
 * Native half of window.ScoreSnapNative on Android (JS side: mobile/www-shim/native-android.js).
 *
 * Methods : getInfo, readPendingFile, saveFile, shareFile, openUrl,
 *           checkForUpdates, getUpdateStatus, installUpdate, getUpdateSettings, setUpdateSettings
 * Events  : "openFile"     {name, mime, size}   — a file arrived via VIEW/SEND intent; JS then calls readPendingFile
 *           "updateStatus" UpdateStatus         — SPEC §6
 */
@CapacitorPlugin(
    name = "ScoreSnapNative",
    permissions = {
        @Permission(alias = ScoreSnapNativePlugin.ALIAS_STORAGE, strings = { Manifest.permission.WRITE_EXTERNAL_STORAGE })
    }
)
public class ScoreSnapNativePlugin extends Plugin {

    static final String ALIAS_STORAGE = "storage";
    private static final String TAG = "ScoreSnapNative";
    private static final String SSNAP_MIME = "application/x-scoresnap";
    private static final long MAX_OPEN_BYTES = 50L * 1024 * 1024;
    private static final String DOWNLOAD_SUBDIR = "JSE";

    private WebUpdater updater;

    private final Object pendingLock = new Object();
    private Uri pendingUri;
    private String pendingName;
    private String pendingMime;
    private long pendingSize;
    private Intent lastHandledIntent;

    /* ------------------------------------------------------------------ lifecycle */

    @Override
    public void load() {
        Context ctx = getContext();
        // Synchronous version info for the shim (window.ScoreSnapNativeSync.getInfoJson()).
        // load() runs before the first page load, so the interface is present from the start.
        try {
            getBridge().getWebView().addJavascriptInterface(new SyncInfoBridge(ctx, getBridge()), SyncInfoBridge.JS_NAME);
        } catch (Exception e) {
            Log.w(TAG, "could not add JavascriptInterface", e);
        }
        updater = new WebUpdater(ctx, getBridge(), nativeVersion(ctx), status -> notifyListeners("updateStatus", status, true));
        new Handler(Looper.getMainLooper()).postDelayed(() -> {
            if (updater != null) updater.checkIfDue();
        }, 4000);
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        if (updater != null) updater.checkIfDue();
    }

    @Override
    protected void handleOnDestroy() {
        if (updater != null) updater.shutdown();
        super.handleOnDestroy();
    }

    /** Called by Bridge for the launch intent (BridgeActivity.load → onNewIntent) and every later one. */
    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        handleIncomingIntent(intent);
    }

    /* ------------------------------------------------------------------ info */

    @PluginMethod
    public void getInfo(PluginCall call) {
        call.resolve(buildInfo(getContext(), getBridge()));
    }

    static JSObject buildInfo(Context ctx, Bridge bridge) {
        JSObject o = new JSObject();
        String v = nativeVersion(ctx);
        o.put("platform", "android");
        o.put("appVersion", v);
        o.put("nativeVersion", v);
        o.put("versionCode", versionCode(ctx));
        o.put("webVersion", WebUpdater.activeVersion(ctx, bridge));
        o.put("packagedWebVersion", WebUpdater.packagedVersion(ctx));
        o.put("updateBaseUrl", ctx.getString(R.string.update_base_url));
        o.put("sdkInt", Build.VERSION.SDK_INT);
        return o;
    }

    static String nativeVersion(Context ctx) {
        PackageInfo pi = packageInfo(ctx);
        return pi != null && pi.versionName != null ? pi.versionName : "0.0.0";
    }

    @SuppressWarnings("deprecation")
    static long versionCode(Context ctx) {
        PackageInfo pi = packageInfo(ctx);
        if (pi == null) return 0;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) return pi.getLongVersionCode();
        return pi.versionCode;
    }

    @SuppressWarnings("deprecation")
    private static PackageInfo packageInfo(Context ctx) {
        try {
            PackageManager pm = ctx.getPackageManager();
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                return pm.getPackageInfo(ctx.getPackageName(), PackageManager.PackageInfoFlags.of(0));
            }
            return pm.getPackageInfo(ctx.getPackageName(), 0);
        } catch (PackageManager.NameNotFoundException e) {
            return null;
        }
    }

    /* ------------------------------------------------------------------ incoming files */

    private void handleIncomingIntent(Intent intent) {
        if (intent == null || intent == lastHandledIntent) return;
        String action = intent.getAction();
        Uri uri = null;
        if (Intent.ACTION_VIEW.equals(action) || Intent.ACTION_EDIT.equals(action)) {
            uri = intent.getData();
        } else if (Intent.ACTION_SEND.equals(action)) {
            uri = streamExtra(intent);
        }
        if (uri == null) return;
        lastHandledIntent = intent;

        String name = displayName(uri);
        String mime = resolveMime(uri, name, intent.getType());
        long size = querySize(uri);
        synchronized (pendingLock) {
            pendingUri = uri;
            pendingName = name;
            pendingMime = mime;
            pendingSize = size;
        }
        JSObject meta = new JSObject();
        meta.put("name", name);
        meta.put("mime", mime);
        meta.put("size", size);
        Log.i(TAG, "incoming file " + name + " (" + mime + ", " + size + " bytes)");
        notifyListeners("openFile", meta, true);
    }

    @SuppressWarnings("deprecation")
    private static Uri streamExtra(Intent intent) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                return intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri.class);
            }
            return intent.getParcelableExtra(Intent.EXTRA_STREAM);
        } catch (Exception e) {
            return null;
        }
    }

    /** Returns {file:{name,mime,base64,size}} or {file:null}; the queued file is consumed. */
    @PluginMethod
    public void readPendingFile(PluginCall call) {
        Uri uri;
        String name;
        String mime;
        long size;
        synchronized (pendingLock) {
            uri = pendingUri;
            name = pendingName;
            mime = pendingMime;
            size = pendingSize;
            pendingUri = null;
        }
        JSObject ret = new JSObject();
        if (uri == null) {
            ret.put("file", JSObject.NULL);
            call.resolve(ret);
            return;
        }
        if (size > MAX_OPEN_BYTES) {
            call.reject("파일이 너무 큽니다 (최대 50 MB): " + name);
            return;
        }
        try {
            byte[] data = readUri(uri);
            JSObject file = new JSObject();
            file.put("name", name);
            file.put("mime", mime);
            file.put("size", data.length);
            file.put("base64", Base64.encodeToString(data, Base64.NO_WRAP));
            ret.put("file", file);
            call.resolve(ret);
        } catch (Exception e) {
            Log.w(TAG, "readPendingFile failed", e);
            call.reject("파일을 읽을 수 없습니다: " + e.getMessage(), e);
        }
    }

    private byte[] readUri(Uri uri) throws IOException {
        ContentResolver cr = getContext().getContentResolver();
        try (InputStream in = cr.openInputStream(uri)) {
            if (in == null) throw new IOException("열 수 없는 URI");
            return WebUpdater.readAll(in, MAX_OPEN_BYTES);
        }
    }

    private String displayName(Uri uri) {
        String name = null;
        if (ContentResolver.SCHEME_CONTENT.equals(uri.getScheme())) {
            try (Cursor c = getContext().getContentResolver().query(uri, new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
                if (c != null && c.moveToFirst()) {
                    int idx = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                    if (idx >= 0) name = c.getString(idx);
                }
            } catch (Exception e) {
                Log.d(TAG, "display name query failed", e);
            }
        } else if (uri.getPath() != null) {
            name = new File(uri.getPath()).getName();
        }
        if (name == null || name.trim().isEmpty()) name = uri.getLastPathSegment();
        if (name == null || name.trim().isEmpty()) name = "file";
        return sanitizeFileName(name);
    }

    private long querySize(Uri uri) {
        if (ContentResolver.SCHEME_CONTENT.equals(uri.getScheme())) {
            try (Cursor c = getContext().getContentResolver().query(uri, new String[] { OpenableColumns.SIZE }, null, null, null)) {
                if (c != null && c.moveToFirst()) {
                    int idx = c.getColumnIndex(OpenableColumns.SIZE);
                    if (idx >= 0 && !c.isNull(idx)) return c.getLong(idx);
                }
            } catch (Exception e) {
                Log.d(TAG, "size query failed", e);
            }
            return -1;
        }
        if (uri.getPath() != null) return new File(uri.getPath()).length();
        return -1;
    }

    private String resolveMime(Uri uri, String name, String intentType) {
        String lower = name.toLowerCase(Locale.ROOT);
        if (lower.endsWith(".ssnap")) return SSNAP_MIME;
        if (isSpecific(intentType)) return intentType;
        String fromResolver = null;
        try {
            fromResolver = getContext().getContentResolver().getType(uri);
        } catch (Exception ignored) {
            // some providers throw
        }
        if (isSpecific(fromResolver)) return fromResolver;
        String fromExt = mimeFromName(name);
        return fromExt != null ? fromExt : "application/octet-stream";
    }

    private static boolean isSpecific(String mime) {
        return mime != null && !mime.isEmpty() && !mime.contains("*") && !mime.equals("application/octet-stream");
    }

    private static String mimeFromName(String name) {
        int dot = name.lastIndexOf('.');
        if (dot < 0 || dot == name.length() - 1) return null;
        String ext = name.substring(dot + 1).toLowerCase(Locale.ROOT);
        switch (ext) {
            case "ssnap": return SSNAP_MIME;
            case "musicxml": return "application/vnd.recordare.musicxml+xml";
            case "mxl": return "application/vnd.recordare.musicxml";
            case "mid": case "midi": return "audio/midi";
            default:
                return MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
        }
    }

    static String sanitizeFileName(String name) {
        String s = name.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
        if (s.isEmpty() || s.equals(".") || s.equals("..")) s = "file";
        if (s.length() > 120) s = s.substring(0, 120);
        return s;
    }

    /* ------------------------------------------------------------------ save / share */

    @PluginMethod
    public void saveFile(PluginCall call) {
        boolean share = Boolean.TRUE.equals(call.getBoolean("share", false));
        if (!share && Build.VERSION.SDK_INT < Build.VERSION_CODES.Q
            && getPermissionState(ALIAS_STORAGE) != PermissionState.GRANTED) {
            requestPermissionForAlias(ALIAS_STORAGE, call, "storagePermissionCallback");
            return;
        }
        doSave(call, share);
    }

    @PluginMethod
    public void shareFile(PluginCall call) {
        doSave(call, true);
    }

    @PermissionCallback
    private void storagePermissionCallback(PluginCall call) {
        // Denied → doSave falls back to the app-specific external folder (no permission needed).
        doSave(call, false);
    }

    private void doSave(PluginCall call, boolean share) {
        String b64 = call.getString("base64");
        if (b64 == null) {
            call.reject("base64 데이터가 없습니다");
            return;
        }
        String name = sanitizeFileName(call.getString("name", "score.ssnap"));
        String mime = call.getString("mime", "application/octet-stream");
        if (mime == null || mime.isEmpty()) mime = "application/octet-stream";
        if (name.toLowerCase(Locale.ROOT).endsWith(".ssnap")) mime = SSNAP_MIME;
        String title = call.getString("title", name);

        byte[] data;
        try {
            data = Base64.decode(b64, Base64.DEFAULT);
        } catch (IllegalArgumentException e) {
            call.reject("base64 데이터가 올바르지 않습니다");
            return;
        }

        try {
            if (share) {
                shareBytes(name, mime, data, title);
                JSObject ret = new JSObject();
                ret.put("shared", true);
                ret.put("path", "");
                call.resolve(ret);
                return;
            }
            JSObject ret = writeToDownloads(name, mime, data);
            call.resolve(ret);
        } catch (Exception e) {
            Log.w(TAG, "saveFile failed", e);
            call.reject("파일을 저장하지 못했습니다: " + e.getMessage(), e);
        }
    }

    private JSObject writeToDownloads(String name, String mime, byte[] data) throws IOException {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            return writeViaMediaStore(name, mime, data);
        }
        return writeLegacy(name, mime, data);
    }

    /** API 29+: MediaStore.Downloads → Download/JSE/<name> (no storage permission needed). */
    @RequiresApi(api = Build.VERSION_CODES.Q)
    private JSObject writeViaMediaStore(String name, String mime, byte[] data) throws IOException {
        ContentResolver cr = getContext().getContentResolver();
        String relPath = Environment.DIRECTORY_DOWNLOADS + "/" + DOWNLOAD_SUBDIR;
        ContentValues values = new ContentValues();
        values.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
        values.put(MediaStore.MediaColumns.MIME_TYPE, mediaStoreMime(name, mime));
        values.put(MediaStore.MediaColumns.RELATIVE_PATH, relPath);
        values.put(MediaStore.MediaColumns.IS_PENDING, 1);
        Uri item = cr.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
        if (item == null) throw new IOException("MediaStore insert failed");
        try (OutputStream out = cr.openOutputStream(item)) {
            if (out == null) throw new IOException("openOutputStream failed");
            out.write(data);
            out.flush();
        } catch (IOException e) {
            cr.delete(item, null, null);
            throw e;
        }
        values.clear();
        values.put(MediaStore.MediaColumns.IS_PENDING, 0);
        cr.update(item, values, null, null);

        String finalName = name;
        try (Cursor c = cr.query(item, new String[] { MediaStore.MediaColumns.DISPLAY_NAME }, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                int idx = c.getColumnIndex(MediaStore.MediaColumns.DISPLAY_NAME);
                if (idx >= 0 && c.getString(idx) != null) finalName = c.getString(idx);
            }
        } catch (Exception ignored) {
            // keep the requested name
        }
        JSObject ret = new JSObject();
        ret.put("path", relPath + "/" + finalName);
        ret.put("uri", item.toString());
        ret.put("name", finalName);
        return ret;
    }

    /**
     * MediaStore appends an extension when the MIME's canonical extension differs from the
     * file name's; use the extension's own MIME when Android knows it, otherwise the given one.
     */
    private static String mediaStoreMime(String name, String mime) {
        int dot = name.lastIndexOf('.');
        if (dot > 0 && dot < name.length() - 1) {
            String ext = name.substring(dot + 1).toLowerCase(Locale.ROOT);
            String known = MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
            if (known != null) return known;
        }
        return mime == null || mime.isEmpty() ? "application/octet-stream" : mime;
    }

    /** API 24–28: public Download/JSE (needs WRITE_EXTERNAL_STORAGE) or app-specific fallback. */
    @SuppressWarnings("deprecation")
    private JSObject writeLegacy(String name, String mime, byte[] data) throws IOException {
        File dir;
        boolean isPublic;
        if (getPermissionState(ALIAS_STORAGE) == PermissionState.GRANTED) {
            dir = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS), DOWNLOAD_SUBDIR);
            isPublic = true;
        } else {
            File base = getContext().getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
            if (base == null) base = new File(getContext().getFilesDir(), "downloads");
            dir = new File(base, DOWNLOAD_SUBDIR);
            isPublic = false;
        }
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("폴더를 만들 수 없습니다: " + dir);
        File file = uniqueFile(dir, name);
        try (OutputStream out = new FileOutputStream(file)) {
            out.write(data);
            out.flush();
        }
        if (isPublic) {
            MediaScannerConnection.scanFile(getContext(), new String[] { file.getAbsolutePath() }, new String[] { mime }, null);
        }
        JSObject ret = new JSObject();
        ret.put("path", isPublic ? Environment.DIRECTORY_DOWNLOADS + "/" + DOWNLOAD_SUBDIR + "/" + file.getName() : file.getAbsolutePath());
        ret.put("uri", Uri.fromFile(file).toString());
        ret.put("name", file.getName());
        return ret;
    }

    private static File uniqueFile(File dir, String name) {
        File f = new File(dir, name);
        if (!f.exists()) return f;
        int dot = name.lastIndexOf('.');
        String base = dot > 0 ? name.substring(0, dot) : name;
        String ext = dot > 0 ? name.substring(dot) : "";
        for (int i = 1; i < 1000; i++) {
            f = new File(dir, base + " (" + i + ")" + ext);
            if (!f.exists()) return f;
        }
        return new File(dir, base + "-" + System.currentTimeMillis() + ext);
    }

    /** Writes to cache/share/<name> and opens the system share sheet through the FileProvider. */
    private void shareBytes(String name, String mime, byte[] data, String title) throws IOException {
        Context ctx = getContext();
        File dir = new File(ctx.getCacheDir(), "share");
        if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("캐시 폴더를 만들 수 없습니다");
        File file = new File(dir, name);
        try (OutputStream out = new FileOutputStream(file)) {
            out.write(data);
            out.flush();
        }
        Uri uri = FileProvider.getUriForFile(ctx, ctx.getPackageName() + ".fileprovider", file);
        Intent send = new Intent(Intent.ACTION_SEND);
        send.setType(mime);
        send.putExtra(Intent.EXTRA_STREAM, uri);
        send.putExtra(Intent.EXTRA_SUBJECT, title);
        send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        final Intent chooser = Intent.createChooser(send, title);
        chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        getActivity().runOnUiThread(() -> getActivity().startActivity(chooser));
    }

    /* ------------------------------------------------------------------ misc */

    @PluginMethod
    public void openUrl(PluginCall call) {
        String url = call.getString("url", "");
        if (url == null || !(url.startsWith("http://") || url.startsWith("https://"))) {
            call.reject("http(s) URL만 열 수 있습니다");
            return;
        }
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            getActivity().runOnUiThread(() -> getActivity().startActivity(i));
            call.resolve();
        } catch (Exception e) {
            call.reject("브라우저를 열 수 없습니다", e);
        }
    }

    /* ------------------------------------------------------------------ updates */

    @PluginMethod
    public void checkForUpdates(PluginCall call) {
        if (updater != null) updater.checkAsync(true);
        call.resolve();
    }

    /** First call after a bundle switch returns {state:'done', version}; otherwise the last status / idle. */
    @PluginMethod
    public void getUpdateStatus(PluginCall call) {
        JSObject s = updater == null ? null : updater.consumeStartupStatus();
        if (s == null && updater != null) s = updater.getLastStatus();
        if (s == null) s = WebUpdater.status("idle");
        call.resolve(s);
    }

    @PluginMethod
    public void installUpdate(final PluginCall call) {
        if (updater == null) {
            call.reject("updater unavailable");
            return;
        }
        updater.installUpdate(new WebUpdater.Result() {
            @Override
            public void ok() {
                call.resolve();
            }

            @Override
            public void fail(String message) {
                call.reject(message);
            }
        });
    }

    @PluginMethod
    public void getUpdateSettings(PluginCall call) {
        if (updater == null) {
            call.reject("updater unavailable");
            return;
        }
        call.resolve(updater.getSettings());
    }

    @PluginMethod
    public void setUpdateSettings(PluginCall call) {
        if (updater == null) {
            call.reject("updater unavailable");
            return;
        }
        updater.setSettings(call.getData());
        call.resolve();
    }
}

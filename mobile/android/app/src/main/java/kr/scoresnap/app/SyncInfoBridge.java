package kr.scoresnap.app;

import android.content.Context;
import android.webkit.JavascriptInterface;

import com.getcapacitor.Bridge;

/**
 * window.ScoreSnapNativeSync.getInfoJson() — lets the JS shim read version info
 * synchronously (SPEC §6 requires ScoreSnapNative.appVersion to be a plain property,
 * while every Capacitor plugin call is asynchronous).  Registered in
 * ScoreSnapNativePlugin.load(), i.e. before the first page load.
 */
public final class SyncInfoBridge {

    public static final String JS_NAME = "ScoreSnapNativeSync";

    private final Context ctx;
    private final Bridge bridge;

    public SyncInfoBridge(Context context, Bridge bridge) {
        this.ctx = context.getApplicationContext();
        this.bridge = bridge;
    }

    /** Runs on the WebView's JavaBridge thread — only cheap, thread-safe reads. */
    @JavascriptInterface
    public String getInfoJson() {
        try {
            return ScoreSnapNativePlugin.buildInfo(ctx, bridge).toString();
        } catch (Exception e) {
            return "{\"platform\":\"android\"}";
        }
    }
}

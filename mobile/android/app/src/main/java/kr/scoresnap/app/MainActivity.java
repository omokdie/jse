package kr.scoresnap.app;

import android.content.Intent;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Local (in-app) plugins must be registered before super.onCreate() creates the Bridge.
        registerPlugin(ScoreSnapNativePlugin.class);
        super.onCreate(savedInstanceState);
        // The bridge exists now. Serve the newest valid web bundle (OTA) or the packaged assets.
        WebUpdater.ensureActiveBundle(this, getBridge());
    }

    /**
     * A .ssnap opened from a file manager / share sheet while the app is running
     * (launchMode="singleTask").  BridgeActivity.onNewIntent → bridge.onNewIntent → every
     * plugin's handleOnNewIntent(), where ScoreSnapNativePlugin queues the file.
     */
    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
    }
}

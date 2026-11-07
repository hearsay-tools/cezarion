package tools.hearsay.cezarion;

import android.app.Application;

/** Runs before any WebView exists, so it can delete WebView files a reset left for this start. */
public final class CezarionApp extends Application {
    @Override public void onCreate() {
        super.onCreate();
        if (BuildConfig.FINAL_OLD_APP) return;
        SiteDataReset.wipeIfRequested(getSharedPreferences("connection", MODE_PRIVATE), getDataDir(), getCacheDir());
    }
}

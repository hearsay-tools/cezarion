package tools.hearsay.cezarion;

import android.app.Application;
import android.content.SharedPreferences;

/** Runs before any WebView exists, so it can delete WebView files a reset left for this start. */
public final class CezarionApp extends Application {
    static final String WIPE_WEBVIEW = "wipeWebView", NOTICE = "notice";

    @Override public void onCreate() {
        super.onCreate();
        SharedPreferences prefs = getSharedPreferences("connection", MODE_PRIVATE);
        if (!prefs.getBoolean(WIPE_WEBVIEW, false)) return;
        SiteDataReset.wipeWebViewFiles(getDataDir(), getCacheDir());
        prefs.edit().remove(WIPE_WEBVIEW).commit();
    }
}

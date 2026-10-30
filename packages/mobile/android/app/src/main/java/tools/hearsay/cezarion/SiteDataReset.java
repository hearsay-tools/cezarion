package tools.hearsay.cezarion;

import android.content.SharedPreferences;
import java.io.File;
import java.util.ArrayList;
import java.util.List;
import java.util.function.Consumer;

/** Rules for removing site data. Only Android interfaces, so JVM tests cover them. */
public final class SiteDataReset {
    static final String WIPE_WEBVIEW = "wipeWebView", NOTICE = "notice";
    private SiteDataReset() {}

    /**
     * Writes a connection change, the wipe request and the notice in one commit, so a process
     * death can never keep the change without the wipe. False when nothing was written.
     */
    public static boolean recordWipe(SharedPreferences prefs, Consumer<SharedPreferences.Editor> change, String notice) {
        SharedPreferences.Editor editor = prefs.edit();
        change.accept(editor);
        return editor.putBoolean(WIPE_WEBVIEW, true).putString(NOTICE, notice).commit();
    }

    /** At app start, before any WebView exists: deletes the WebView files when a reset asked for it. */
    public static boolean wipeIfRequested(SharedPreferences prefs, File dataDir, File cacheDir) {
        if (!prefs.getBoolean(WIPE_WEBVIEW, false)) return false;
        wipeWebViewFiles(dataDir, cacheDir);
        prefs.edit().remove(WIPE_WEBVIEW).commit();
        return true;
    }

    /** Profiles to delete at app start: every one except the default and the current one. */
    public static List<String> unusedProfiles(List<String> names, String keep, String defaultName) {
        List<String> unused = new ArrayList<>();
        for (String name : names) if (!name.equals(defaultName) && !name.equals(keep)) unused.add(name);
        return unused;
    }

    /**
     * Deletes every WebView data and cache directory of this app: cookies, storage, Cache
     * Storage, service workers and profiles. Only safe before any WebView exists in the process.
     */
    public static void wipeWebViewFiles(File dataDir, File cacheDir) {
        deleteChildren(dataDir, "app_webview");
        deleteChildren(cacheDir, "WebView");
        deleteChildren(cacheDir, "org.chromium.android_webview");
    }

    private static void deleteChildren(File dir, String prefix) {
        File[] children = dir.listFiles();
        if (children == null) return;
        for (File child : children) if (child.getName().equals(prefix) || child.getName().startsWith(prefix + "_")) delete(child);
    }

    private static void delete(File file) {
        File[] children = file.listFiles();
        if (children != null) for (File child : children) delete(child);
        file.delete();
    }
}

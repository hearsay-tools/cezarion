package tools.hearsay.cezarion;

import java.io.File;
import java.util.ArrayList;
import java.util.List;

/** File and name rules for removing site data. No Android types, so JVM tests cover them. */
public final class SiteDataReset {
    private SiteDataReset() {}

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

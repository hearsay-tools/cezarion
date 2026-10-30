package tools.hearsay.cezarion;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import android.content.SharedPreferences;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import static org.junit.Assert.*;

public class SiteDataResetTest {
    @Rule public TemporaryFolder folder = new TemporaryFolder();

    /** Stores values in memory and records each write: which keys it held and whether it committed. */
    static final class Prefs implements SharedPreferences {
        final Map<String, Object> values = new HashMap<>();
        final List<String> writes = new ArrayList<>();
        boolean commitSucceeds = true;
        final class Editor implements SharedPreferences.Editor {
            final Map<String, Object> puts = new HashMap<>(); final List<String> removes = new ArrayList<>();
            private boolean write(String kind) {
                List<String> keys = new ArrayList<>(puts.keySet()); keys.addAll(removes); keys.sort(null);
                writes.add(kind + " " + keys);
                if (kind.equals("commit") && !commitSucceeds) return false;
                for (String key : removes) values.remove(key);
                values.putAll(puts); return true;
            }
            @Override public Editor putString(String key, String value) { puts.put(key, value); return this; }
            @Override public Editor putStringSet(String key, Set<String> value) { puts.put(key, value); return this; }
            @Override public Editor putInt(String key, int value) { puts.put(key, value); return this; }
            @Override public Editor putLong(String key, long value) { puts.put(key, value); return this; }
            @Override public Editor putFloat(String key, float value) { puts.put(key, value); return this; }
            @Override public Editor putBoolean(String key, boolean value) { puts.put(key, value); return this; }
            @Override public Editor remove(String key) { removes.add(key); return this; }
            @Override public Editor clear() { throw new UnsupportedOperationException(); }
            @Override public boolean commit() { return write("commit"); }
            @Override public void apply() { write("apply"); }
        }
        @Override public Map<String, ?> getAll() { return values; }
        @Override public String getString(String key, String fallback) { return (String) values.getOrDefault(key, fallback); }
        @SuppressWarnings("unchecked") @Override public Set<String> getStringSet(String key, Set<String> fallback) { return (Set<String>) values.getOrDefault(key, fallback); }
        @Override public int getInt(String key, int fallback) { return (Integer) values.getOrDefault(key, fallback); }
        @Override public long getLong(String key, long fallback) { return (Long) values.getOrDefault(key, fallback); }
        @Override public float getFloat(String key, float fallback) { return (Float) values.getOrDefault(key, fallback); }
        @Override public boolean getBoolean(String key, boolean fallback) { return (Boolean) values.getOrDefault(key, fallback); }
        @Override public boolean contains(String key) { return values.containsKey(key); }
        @Override public Editor edit() { return new Editor(); }
        @Override public void registerOnSharedPreferenceChangeListener(OnSharedPreferenceChangeListener listener) {}
        @Override public void unregisterOnSharedPreferenceChangeListener(OnSharedPreferenceChangeListener listener) {}
    }

    @Test public void recordsTheConnectionChangeAndTheWipeInOneCommit() {
        Prefs prefs = new Prefs();
        assertTrue(SiteDataReset.recordWipe(prefs, editor -> editor.putString("endpoint", "https://new.example.com").putString("auth", ""), "cleared"));
        assertEquals(List.of("commit [auth, endpoint, notice, wipeWebView]"), prefs.writes);
        assertEquals("https://new.example.com", prefs.getString("endpoint", null));
        assertTrue(prefs.getBoolean("wipeWebView", false));
        assertEquals("cleared", prefs.getString("notice", null));
    }

    @Test public void reportsAFailedCommitAndKeepsTheOldConnection() {
        Prefs prefs = new Prefs(); prefs.values.put("endpoint", "https://old.example.com"); prefs.commitSucceeds = false;
        assertFalse(SiteDataReset.recordWipe(prefs, editor -> editor.remove("endpoint").remove("auth"), "cleared"));
        assertEquals("https://old.example.com", prefs.getString("endpoint", null));
        assertFalse(prefs.contains("wipeWebView"));
    }

    @Test public void wipesAtStartOnlyWhenAResetAskedForIt() throws IOException {
        File data = folder.newFolder("start-data"), cache = folder.newFolder("start-cache");
        File worker = put(data, "app_webview/Default/Service Worker/Database/MANIFEST");
        Prefs prefs = new Prefs();
        assertFalse(SiteDataReset.wipeIfRequested(prefs, data, cache));
        assertTrue(worker.exists());
        prefs.values.put("wipeWebView", true);
        assertTrue(SiteDataReset.wipeIfRequested(prefs, data, cache));
        assertFalse(worker.exists());
        assertFalse(prefs.contains("wipeWebView"));
    }

    private File put(File root, String path) throws IOException {
        File file = new File(root, path); file.getParentFile().mkdirs(); Files.write(file.toPath(), new byte[] { (byte) 120 }); return file;
    }

    @Test public void deletesAbandonedProfilesButKeepsDefaultAndCurrent() {
        assertEquals(List.of("cockpit-old", "cockpit-older"),
            SiteDataReset.unusedProfiles(List.of("Default", "cockpit-old", "cockpit-now", "cockpit-older"), "cockpit-now", "Default"));
        assertEquals(List.of("cockpit-old"), SiteDataReset.unusedProfiles(List.of("Default", "cockpit-old"), "Default", "Default"));
    }

    @Test public void wipesEveryWebViewDirectoryAndKeepsTheConnectionPreferences() throws IOException {
        File data = folder.newFolder("data"), cache = folder.newFolder("cache");
        File worker = put(data, "app_webview/Default/Service Worker/Database/MANIFEST");
        File caches = put(data, "app_webview/Default/Service Worker/CacheStorage/index");
        File suffixed = put(data, "app_webview_other/Default/Cookies");
        File http = put(cache, "WebView/Default/HTTP Cache/data_0");
        File legacy = put(cache, "org.chromium.android_webview/data_1");
        File prefs = put(data, "shared_prefs/connection.xml");
        File unrelated = put(data, "app_webviewer/keep");
        SiteDataReset.wipeWebViewFiles(data, cache);
        for (File gone : new File[]{worker, caches, suffixed, http, legacy}) assertFalse(gone.getPath(), gone.exists());
        assertFalse(new File(data, "app_webview").exists());
        assertTrue(prefs.exists()); assertTrue(unrelated.exists());
    }
}

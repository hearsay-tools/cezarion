package tools.hearsay.cezarion;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.util.List;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;
import static org.junit.Assert.*;

public class SiteDataResetTest {
    @Rule public TemporaryFolder folder = new TemporaryFolder();

    private File put(File root, String path) throws IOException {
        File file = new File(root, path); file.getParentFile().mkdirs(); Files.writeString(file.toPath(), "x"); return file;
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

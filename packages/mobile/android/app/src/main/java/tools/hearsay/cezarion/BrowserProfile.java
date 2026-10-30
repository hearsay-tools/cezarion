package tools.hearsay.cezarion;

import android.content.SharedPreferences;
import android.webkit.CookieManager;
import android.webkit.WebStorage;
import android.webkit.WebView;
import androidx.webkit.Profile;
import androidx.webkit.ProfileStore;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import java.util.UUID;

/**
 * One WebView profile per connection. A profile holds every kind of site data: cookies,
 * storage, HTTP cache, Cache Storage and service workers. A new connection starts with an
 * empty profile, so nothing from a previous account reaches it. Chromium refuses to delete
 * a profile this process has loaded, so the previous one is deleted on the next app start.
 */
public final class BrowserProfile {
    private static final String KEY = "profile";
    private BrowserProfile() {}

    public static String current(SharedPreferences prefs) { return prefs.getString(KEY, Profile.DEFAULT_PROFILE_NAME); }

    /** Call before anything else on a new WebView. */
    public static void use(WebView web, SharedPreferences prefs) {
        String name = current(prefs);
        if (WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE) && !Profile.DEFAULT_PROFILE_NAME.equals(name))
            WebViewCompat.setProfile(web, name);
    }

    public static CookieManager cookies(SharedPreferences prefs) {
        String name = current(prefs);
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE) || Profile.DEFAULT_PROFILE_NAME.equals(name)) return CookieManager.getInstance();
        return ProfileStore.getInstance().getOrCreateProfile(name).getCookieManager();
    }

    public static WebStorage storage(SharedPreferences prefs) {
        String name = current(prefs);
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE) || Profile.DEFAULT_PROFILE_NAME.equals(name)) return WebStorage.getInstance();
        return ProfileStore.getInstance().getOrCreateProfile(name).getWebStorage();
    }

    /** Switches to a new, empty profile when this WebView supports profiles. */
    public static void rotate(SharedPreferences prefs) {
        if (WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE))
            prefs.edit().putString(KEY, "cockpit-" + UUID.randomUUID()).commit();
    }

    /** Deletes every connection profile except the current one. Call before any WebView exists. */
    public static void deleteUnused(SharedPreferences prefs) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) return;
        ProfileStore store = ProfileStore.getInstance();
        String keep = current(prefs);
        for (String name : store.getAllProfileNames()) {
            if (name.equals(Profile.DEFAULT_PROFILE_NAME) || name.equals(keep)) continue;
            // Loaded earlier in this process (only in tests, which reuse one process): next start.
            try { store.deleteProfile(name); } catch (IllegalStateException ignored) {}
        }
    }
}

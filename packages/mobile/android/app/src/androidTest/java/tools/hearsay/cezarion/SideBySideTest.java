package tools.hearsay.cezarion;

import android.content.SharedPreferences;
import android.webkit.WebView;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import static androidx.test.espresso.Espresso.onView;
import static androidx.test.espresso.assertion.ViewAssertions.matches;
import static androidx.test.espresso.matcher.ViewMatchers.*;
import static org.junit.Assert.*;
import static org.junit.Assume.assumeTrue;

/** Run in three separate processes with both application IDs installed. */
@RunWith(AndroidJUnit4.class)
public class SideBySideTest {
    private static final String ENDPOINT = "https://isolation.example.test";
    private static final String AUTH = "https://login.isolation.example.test";
    private static final String SESSION = "mobile_isolation=legacy-session";

    @Before public void explicitSideBySideRunOnly() {
        var args = InstrumentationRegistry.getArguments();
        assumeTrue("Run through scripts/side-by-side-android.sh", "true".equals(args.getString("sideBySide")));
        assertEquals(args.getString("expectedAppId"), InstrumentationRegistry.getInstrumentation().getTargetContext().getPackageName());
        assertFalse(BuildConfig.FINAL_OLD_APP);
    }

    private SharedPreferences prefs() {
        return InstrumentationRegistry.getInstrumentation().getTargetContext().getSharedPreferences("connection", 0);
    }

    @Test public void seedLegacySession() throws Exception {
        assertTrue(prefs().edit().putString("endpoint", ENDPOINT).putString("auth", AUTH).commit());
        CountDownLatch stored = new CountDownLatch(1);
        AtomicReference<Boolean> accepted = new AtomicReference<>(false);
        try (ActivityScenario<MainActivity> activity = ActivityScenario.launch(MainActivity.class)) {
            activity.onActivity(app -> {
                WebView browser = new WebView(app);
                BrowserProfile.use(browser, prefs());
                var cookies = BrowserProfile.cookies(prefs());
                cookies.setCookie(ENDPOINT, SESSION + "; Secure; Path=/; Max-Age=86400", success -> {
                    accepted.set(success);
                    cookies.flush();
                    browser.destroy();
                    stored.countDown();
                });
            });
            // bound: Chromium must acknowledge and persist the synthetic sign-in cookie.
            assertTrue(stored.await(10, TimeUnit.SECONDS));
            assertTrue(accepted.get());
            onView(withContentDescription("Cockpit address")).check(matches(withText(ENDPOINT)));
            assertEquals(SESSION, cookie());
        }
    }

    @Test public void newAppNeedsConnectionAndSignIn() {
        // Inspect before any connection/reset action could hide an accidental import.
        assertFalse(prefs().contains("endpoint"));
        assertFalse(prefs().contains("auth"));
        try (ActivityScenario<MainActivity> activity = ActivityScenario.launch(MainActivity.class)) {
            onView(withContentDescription("Cockpit address")).check(matches(withText("")));
            onView(withContentDescription("Trusted sign-in origin")).check(matches(withText("")));
            assertNull("The new WebView must not inherit the old sign-in", cookie());
        }
    }

    @Test public void legacySessionRemainsUnchanged() {
        assertEquals(ENDPOINT, prefs().getString("endpoint", null));
        assertEquals(AUTH, prefs().getString("auth", null));
        try (ActivityScenario<MainActivity> activity = ActivityScenario.launch(MainActivity.class)) {
            onView(withContentDescription("Cockpit address")).check(matches(withText(ENDPOINT)));
            onView(withContentDescription("Trusted sign-in origin")).check(matches(withText(AUTH)));
            assertEquals(SESSION, cookie());
        }
    }

    private String cookie() {
        AtomicReference<String> value = new AtomicReference<>();
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> value.set(BrowserProfile.cookies(prefs()).getCookie(ENDPOINT)));
        return value.get();
    }
}

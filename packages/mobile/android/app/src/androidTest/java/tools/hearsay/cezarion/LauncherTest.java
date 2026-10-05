package tools.hearsay.cezarion;

import android.webkit.CookieManager;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import static androidx.test.espresso.Espresso.onView;
import static androidx.test.espresso.action.ViewActions.*;
import static androidx.test.espresso.assertion.ViewAssertions.*;
import static androidx.test.espresso.matcher.ViewMatchers.*;
import static org.hamcrest.Matchers.containsString;
import static org.junit.Assert.*;

@RunWith(AndroidJUnit4.class)
public class LauncherTest {
    @Test public void rejectsHTTPWithoutOpeningAWebView() {
        try (ActivityScenario<MainActivity> activity = ActivityScenario.launch(MainActivity.class)) {
            onView(withContentDescription("Cockpit address")).perform(replaceText("http://example.com"), closeSoftKeyboard());
            onView(withText("Connect")).perform(scrollTo(), click());
            onView(withText(containsString("Enter an HTTPS address"))).check(matches(isDisplayed()));
        }
    }

    @Test public void forgetRemovesStoredAddressAndCookies() throws Exception {
        CountDownLatch seeded = new CountDownLatch(1);
        try (ActivityScenario<MainActivity> activity = ActivityScenario.launch(MainActivity.class)) {
            activity.onActivity(app -> {
                app.getSharedPreferences("connection", 0).edit().putString("endpoint", "https://example.com").putString("auth", "").commit();
                CookieManager.getInstance().setAcceptCookie(true);
                CookieManager.getInstance().setCookie("https://example.com", "cezar_test=present; Secure; Path=/", ignored -> seeded.countDown());
            });
            assertTrue(seeded.await(5, TimeUnit.SECONDS));
            assertTrue(CookieManager.getInstance().getCookie("https://example.com").contains("cezar_test"));
            onView(withText("Forget connection & sign out")).perform(scrollTo(), click());
            onView(withText("Forget")).perform(click());
            long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10);
            var context = InstrumentationRegistry.getInstrumentation().getTargetContext();
            while (context.getSharedPreferences("connection", 0).contains("endpoint") && System.nanoTime() < deadline) Thread.sleep(50);
            assertFalse(context.getSharedPreferences("connection", 0).contains("endpoint"));
            assertNull(CookieManager.getInstance().getCookie("https://example.com"));
            onView(withContentDescription("Cockpit address")).check(matches(withText("")));
        }
    }
}

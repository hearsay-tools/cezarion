package tools.hearsay.cezarion;

import android.app.Activity;
import android.app.Instrumentation;
import android.content.Intent;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.Test;
import org.junit.runner.RunWith;
import static androidx.test.espresso.Espresso.onView;
import static androidx.test.espresso.action.ViewActions.*;
import static androidx.test.espresso.assertion.ViewAssertions.*;
import static androidx.test.espresso.matcher.ViewMatchers.*;
import static org.junit.Assert.*;
import static org.junit.Assume.assumeTrue;

@RunWith(AndroidJUnit4.class)
public class FinalOldAppTest {
    @Test public void onlyMoveScreenOpensSuppliedStorePageAndPreservesOldConnection() {
        assumeTrue(BuildConfig.FINAL_OLD_APP);
        Instrumentation instrumentation = InstrumentationRegistry.getInstrumentation();
        var prefs = instrumentation.getTargetContext().getSharedPreferences("connection", 0);
        String previous = prefs.getString("endpoint", null);
        prefs.edit().putString("endpoint", "https://old.example.com").commit();
        AtomicReference<Intent> opened = new AtomicReference<>();
        Instrumentation.ActivityMonitor monitor = new Instrumentation.ActivityMonitor() {
            @Override public Instrumentation.ActivityResult onStartActivity(Intent intent) {
                if (!Intent.ACTION_VIEW.equals(intent.getAction())) return null;
                opened.set(intent);
                return new Instrumentation.ActivityResult(Activity.RESULT_OK, null);
            }
        };
        instrumentation.addMonitor(monitor);
        try (ActivityScenario<MainActivity> activity = ActivityScenario.launch(MainActivity.class)) {
            onView(withText("Move to " + BuildConfig.MOVE_DISPLAY_NAME)).check(matches(isDisplayed()));
            onView(withText("Install the new app. Connect to your server and sign in again. Your connection and sign-in are not copied.")).check(matches(isDisplayed()));
            onView(withContentDescription("Cockpit address")).check(doesNotExist());
            onView(withText("Connect")).check(doesNotExist());
            onView(withContentDescription("Cockpit")).check(doesNotExist());
            onView(withText("Get " + BuildConfig.MOVE_DISPLAY_NAME)).perform(scrollTo(), click());
            assertNotNull(opened.get());
            assertEquals(BuildConfig.STORE_URL, opened.get().getDataString());
            assertEquals("https://old.example.com", prefs.getString("endpoint", null));
        } finally {
            instrumentation.removeMonitor(monitor);
            prefs.edit().putString("endpoint", previous).commit();
        }
    }
}

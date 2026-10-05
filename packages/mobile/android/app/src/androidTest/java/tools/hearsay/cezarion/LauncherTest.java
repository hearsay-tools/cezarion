package tools.hearsay.cezarion;

import android.webkit.CookieManager;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import android.view.View;
import android.view.ViewGroup;
import androidx.test.espresso.action.CoordinatesProvider;
import androidx.test.espresso.action.GeneralSwipeAction;
import androidx.test.espresso.action.Press;
import androidx.test.espresso.action.Swipe;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.Callable;
import static androidx.test.espresso.Espresso.onView;
import static androidx.test.espresso.action.ViewActions.*;
import static androidx.test.espresso.assertion.ViewAssertions.*;
import static androidx.test.espresso.matcher.ViewMatchers.*;
import static org.hamcrest.Matchers.containsString;
import static org.junit.Assert.*;

@RunWith(AndroidJUnit4.class)
public class LauncherTest {
    private static WebView findWeb(View view) {
        if (view instanceof WebView web) return web;
        if (view instanceof ViewGroup group) for (int i = 0; i < group.getChildCount(); i++) {
            WebView web = findWeb(group.getChildAt(i)); if (web != null) return web;
        }
        return null;
    }
    private static void until(Callable<Boolean> condition) throws Exception {
        long deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(15);
        while (!condition.call()) { if (System.nanoTime() > deadline) fail("Timed out waiting for browser state"); Thread.sleep(50); }
    }
    private static String script(ActivityScenario<MainActivity> activity, String source) throws Exception {
        CountDownLatch done = new CountDownLatch(1);
        AtomicReference<String> value = new AtomicReference<>();
        activity.onActivity(app -> findWeb(app.findViewById(android.R.id.content)).evaluateJavascript(source, result -> { value.set(result); done.countDown(); }));
        assertTrue(done.await(5, TimeUnit.SECONDS)); return value.get();
    }
    private static void connect(ActivityScenario<MainActivity> activity) throws Exception {
        onView(withContentDescription("Cockpit address")).perform(replaceText("https://127.0.0.1:65534"), closeSoftKeyboard());
        onView(withContentDescription("Trusted sign-in origin")).perform(replaceText(""), closeSoftKeyboard());
        onView(withText("Connect")).perform(scrollTo(), click());
        until(() -> {
            AtomicReference<WebView> web = new AtomicReference<>();
            activity.onActivity(app -> web.set(findWeb(app.findViewById(android.R.id.content))));
            return web.get() != null;
        });
    }
    private static CoordinatesProvider point(float x, float y) {
        return view -> { int[] location = new int[2]; view.getLocationOnScreen(location); return new float[]{location[0] + view.getWidth() * x, location[1] + view.getHeight() * y}; };
    }
    private static void drag(float startY, float endY) {
        onView(withContentDescription("Cockpit")).perform(new GeneralSwipeAction(Swipe.SLOW, point(.5f, startY), point(.5f, endY), Press.FINGER));
    }

    @Test public void compactControlsCanReturnToConnectionSettings() throws Exception {
        try (ActivityScenario<MainActivity> activity = ActivityScenario.launch(MainActivity.class)) {
            connect(activity);
            onView(withText("Connection")).check(doesNotExist());
            onView(withText("Refresh")).check(doesNotExist());
            onView(withContentDescription("Browser controls")).perform(click());
            onView(withText("Connection settings")).perform(click());
            onView(withContentDescription("Cockpit address")).check(matches(withText("https://127.0.0.1:65534")));
        }
    }

    @Test public void systemBackAndTopPullWorkWithoutHijackingNestedScroll() throws Exception {
        try (ActivityScenario<MainActivity> activity = ActivityScenario.launch(MainActivity.class)) {
            connect(activity);
            // A real WebView with the cockpit's fixed-document/nested-scroller shape.
            String fixture = "<meta name='viewport' content='width=device-width,initial-scale=1'><style>body{margin:0;height:100dvh;overflow:hidden}header{height:48px}main{height:calc(100dvh - 48px);overflow:auto;overscroll-behavior:contain}p{height:100px}</style><header>Gesture test</header><main><div id='page'>First page</div><div id='rows'></div></main><script>for(let i=0;i<30;i++)document.getElementById('rows').innerHTML+='<p>Row '+i+'</p>';onpopstate=()=>document.getElementById('page').textContent='First page';</script>";
            activity.onActivity(app -> {
                WebView web = findWeb(app.findViewById(android.R.id.content));
                WebViewClient original = web.getWebViewClient();
                web.setWebViewClient(new WebViewClient() {
                    @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                        if (request.getUrl().toString().startsWith("https://127.0.0.1:65534/"))
                            return new WebResourceResponse("text/html", "UTF-8", new ByteArrayInputStream(fixture.getBytes(StandardCharsets.UTF_8)));
                        return original.shouldInterceptRequest(view, request);
                    }
                    @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) { return original.shouldOverrideUrlLoading(view, request); }
                    @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) { original.onPageStarted(view, url, favicon); }
                    @Override public void onPageFinished(WebView view, String url) { original.onPageFinished(view, url); }
                });
                web.loadUrl("https://127.0.0.1:65534/first");
            });
            until(() -> "\"First page\"".equals(script(activity, "document.getElementById('page')?.textContent")));
            script(activity, "history.pushState({},'', '/second');document.getElementById('page').textContent='Second page'");
            drag(.8f, .25f); drag(.4f, .85f);
            assertEquals("\"Second page\"", script(activity, "document.getElementById('page').textContent"));
            androidx.test.espresso.Espresso.pressBack();
            until(() -> "\"First page\"".equals(script(activity, "document.getElementById('page')?.textContent")));
            onView(withContentDescription("Browser controls")).check(matches(isDisplayed()));
            script(activity, "document.getElementById('page').textContent='Changed before refresh'");
            drag(.02f, .5f);
            until(() -> !"\"Changed before refresh\"".equals(script(activity, "document.getElementById('page')?.textContent")));
            onView(withContentDescription("Browser controls")).perform(click());
            onView(withText("Connection settings")).perform(click());
        }
    }

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

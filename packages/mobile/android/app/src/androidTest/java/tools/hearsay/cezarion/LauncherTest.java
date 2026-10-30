package tools.hearsay.cezarion;

import android.content.SharedPreferences;
import android.webkit.CookieManager;
import android.webkit.ServiceWorkerClient;
import android.webkit.ServiceWorkerController;
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
import androidx.test.espresso.action.GeneralClickAction;
import androidx.test.espresso.action.Press;
import androidx.test.espresso.action.Swipe;
import androidx.test.espresso.action.Tap;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import androidx.webkit.Profile;
import androidx.webkit.ProfileStore;
import androidx.webkit.WebViewFeature;
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
import static org.junit.Assume.assumeTrue;

@RunWith(AndroidJUnit4.class)
public class LauncherTest {
    // The most recently added WebView: a probe when one is open, else the cockpit.
    private static WebView findWeb(View view) {
        if (view instanceof WebView web) return web;
        if (view instanceof ViewGroup group) for (int i = group.getChildCount() - 1; i >= 0; i--) {
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
        activity.onActivity(app -> {
            WebView web = findWeb(app.findViewById(android.R.id.content));
            assertNotNull("Cockpit must remain open while evaluating: " + source, web);
            web.evaluateJavascript(source, result -> { value.set(result); done.countDown(); });
        });
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
    // Runs an async function body in the page and returns its JSON-encoded result.
    private static String promise(ActivityScenario<MainActivity> activity, String body) throws Exception {
        script(activity, "window.cezarResult=undefined;(async()=>{" + body + "})().then(v=>window.cezarResult=JSON.stringify(v),e=>window.cezarResult='error: '+e)");
        AtomicReference<String> value = new AtomicReference<>();
        until(() -> { value.set(script(activity, "window.cezarResult ?? null")); return !"null".equals(value.get()); });
        return value.get();
    }
    private static ServiceWorkerController workers(SharedPreferences prefs) {
        String name = BrowserProfile.current(prefs);
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE) || Profile.DEFAULT_PROFILE_NAME.equals(name)) return ServiceWorkerController.getInstance();
        return ProfileStore.getInstance().getOrCreateProfile(name).getServiceWorkerController();
    }
    // Serves a page and a service worker script on the cockpit origin of the open WebView.
    private static void serveSiteData(ActivityScenario<MainActivity> activity) throws Exception {
        activity.onActivity(app -> serve(app, findWeb(app.findViewById(android.R.id.content))));
        until(() -> "\"Site data\"".equals(script(activity, "document.getElementById('page')?.textContent")));
    }
    // A WebView on the current profile that the app did not open: reads site data without any app reset.
    private static void probeSiteData(ActivityScenario<MainActivity> activity) throws Exception {
        activity.onActivity(app -> {
            WebView probe = new WebView(app); BrowserProfile.use(probe, app.getSharedPreferences("connection", 0));
            probe.getSettings().setJavaScriptEnabled(true); probe.getSettings().setDomStorageEnabled(true);
            probe.setWebViewClient(new WebViewClient());
            ((ViewGroup)app.findViewById(android.R.id.content)).addView(probe, new ViewGroup.LayoutParams(1, 1));
            serve(app, probe);
        });
        until(() -> "\"Site data\"".equals(script(activity, "document.getElementById('page')?.textContent")));
    }
    private static void serve(MainActivity app, WebView web) {
        workers(app.getSharedPreferences("connection", 0)).setServiceWorkerClient(new ServiceWorkerClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebResourceRequest request) {
                if (!request.getUrl().toString().equals("https://127.0.0.1:65534/sw.js")) return null;
                return new WebResourceResponse("text/javascript", "UTF-8", new ByteArrayInputStream("self.oninstall=()=>self.skipWaiting()".getBytes(StandardCharsets.UTF_8)));
            }
        });
        WebViewClient original = web.getWebViewClient();
        web.setWebViewClient(new WebViewClient() {
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                if (request.getUrl().toString().startsWith("https://127.0.0.1:65534/"))
                    return new WebResourceResponse("text/html", "UTF-8", new ByteArrayInputStream("<p id='page'>Site data</p>".getBytes(StandardCharsets.UTF_8)));
                return original.shouldInterceptRequest(view, request);
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) { return original.shouldOverrideUrlLoading(view, request); }
            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) { original.onPageStarted(view, url, favicon); }
            @Override public void onPageFinished(WebView view, String url) { original.onPageFinished(view, url); }
        });
        web.loadUrl("https://127.0.0.1:65534/site-data");
    }
    private static final String COUNT = "return (await navigator.serviceWorker.getRegistrations()).length + ' workers, ' + (await caches.keys()).length + ' caches'";
    private static void seedSiteData(ActivityScenario<MainActivity> activity) throws Exception {
        serveSiteData(activity);
        assertEquals("\"installed\"", promise(activity, "await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready; await (await caches.open('cezar-test')).put('/cached', new Response('cached')); return 'installed'"));
        assertEquals("\"1 workers, 1 caches\"", promise(activity, COUNT));
    }
    // Without profiles or DELETE_BROWSING_DATA a reset restarts the process, which ends the test run.
    private static void assumeInProcessReset() {
        AtomicReference<Boolean> supported = new AtomicReference<>();
        InstrumentationRegistry.getInstrumentation().runOnMainSync(() -> supported.set(BrowserProfile.resetsInProcess()));
        assumeTrue("This WebView resets site data by restarting the app", supported.get());
    }
    private static void forget() throws Exception {
        onView(withText("Forget connection & sign out")).perform(scrollTo(), click());
        onView(withText("Forget")).perform(click());
        var prefs = InstrumentationRegistry.getInstrumentation().getTargetContext().getSharedPreferences("connection", 0);
        // Forget removes the address only after the browser data is cleared.
        until(() -> !prefs.contains("endpoint"));
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
            String fixture = "<meta name='viewport' content='width=device-width,initial-scale=1'><style>body{margin:0;height:100dvh;overflow:hidden}header,button{height:48px}button{width:160px}main{height:calc(100dvh - 48px);overflow:auto;overscroll-behavior:contain}p{height:100px}</style><header><button onclick=\"history.pushState({},'', '/second');document.getElementById('page').textContent='Second page'\">Next page</button></header><main><div id='page'>First page</div><div id='rows'></div></main><script>for(let i=0;i<30;i++)document.getElementById('rows').innerHTML+='<p>Row '+i+'</p>';onpopstate=()=>document.getElementById('page').textContent='First page';</script>";
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
            until(() -> "\"complete\"".equals(script(activity, "document.readyState")));
            // Exercise user-initiated history. Chromium may skip script-created entries
            // with no user activation when processing the browser/system Back action.
            onView(withContentDescription("Cockpit")).perform(new GeneralClickAction(Tap.SINGLE, view -> {
                int[] location = new int[2]; view.getLocationOnScreen(location);
                float density = view.getResources().getDisplayMetrics().density;
                return new float[]{location[0] + 80 * density, location[1] + 24 * density};
            }, Press.FINGER));
            until(() -> "\"Second page\"".equals(script(activity, "document.getElementById('page')?.textContent")));
            until(() -> {
                AtomicReference<Boolean> ready = new AtomicReference<>(false);
                activity.onActivity(app -> {
                    WebView web = findWeb(app.findViewById(android.R.id.content));
                    ready.set(web != null && web.canGoBack() && web.getUrl().endsWith("/second"));
                });
                return ready.get();
            });
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
        assumeInProcessReset();
        CountDownLatch seeded = new CountDownLatch(1);
        AtomicReference<CookieManager> before = new AtomicReference<>();
        try (ActivityScenario<MainActivity> activity = ActivityScenario.launch(MainActivity.class)) {
            activity.onActivity(app -> {
                SharedPreferences prefs = app.getSharedPreferences("connection", 0);
                prefs.edit().putString("endpoint", "https://example.com").putString("auth", "").commit();
                CookieManager jar = BrowserProfile.cookies(prefs); before.set(jar);
                jar.setAcceptCookie(true);
                jar.setCookie("https://example.com", "cezar_test=present; Secure; Path=/", ignored -> seeded.countDown());
            });
            assertTrue(seeded.await(5, TimeUnit.SECONDS));
            assertTrue(before.get().getCookie("https://example.com").contains("cezar_test"));
            forget();
            assertNull(before.get().getCookie("https://example.com"));
            activity.onActivity(app -> assertNull(BrowserProfile.cookies(app.getSharedPreferences("connection", 0)).getCookie("https://example.com")));
            onView(withContentDescription("Cockpit address")).check(matches(withText("")));
        }
    }

    @Test public void forgetRemovesServiceWorkersAndCacheStorage() throws Exception {
        assumeInProcessReset();
        try (ActivityScenario<MainActivity> activity = ActivityScenario.launch(MainActivity.class)) {
            connect(activity);
            seedSiteData(activity);
            onView(withContentDescription("Browser controls")).perform(click());
            onView(withText("Connection settings")).perform(click());
            forget();
            // Read the profile Forget left, before Connect could clear anything itself.
            probeSiteData(activity);
            assertEquals("\"0 workers, 0 caches\"", promise(activity, COUNT));
        }
    }

    @Test public void changingTheTrustedPairRemovesServiceWorkersAndCacheStorage() throws Exception {
        assumeInProcessReset();
        try (ActivityScenario<MainActivity> activity = ActivityScenario.launch(MainActivity.class)) {
            connect(activity);
            seedSiteData(activity);
            onView(withContentDescription("Browser controls")).perform(click());
            onView(withText("Connection settings")).perform(click());
            onView(withContentDescription("Trusted sign-in origin")).perform(replaceText("https://auth.example.com"), closeSoftKeyboard());
            onView(withText("Connect")).perform(scrollTo(), click());
            var prefs = InstrumentationRegistry.getInstrumentation().getTargetContext().getSharedPreferences("connection", 0);
            until(() -> "https://auth.example.com".equals(prefs.getString("auth", "")));
            until(() -> {
                AtomicReference<WebView> web = new AtomicReference<>();
                activity.onActivity(app -> web.set(findWeb(app.findViewById(android.R.id.content))));
                return web.get() != null;
            });
            serveSiteData(activity);
            assertEquals("\"0 workers, 0 caches\"", promise(activity, COUNT));
        }
    }
}

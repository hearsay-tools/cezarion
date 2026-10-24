package tools.hearsay.cezarion;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Typeface;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Bundle;
import android.os.Message;
import android.text.InputType;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.*;
import android.widget.*;

public final class MainActivity extends Activity {
    private static final int NAVY = Color.rgb(11, 16, 28), AMBER = Color.rgb(255, 186, 56);
    private SharedPreferences prefs;
    private LinearLayout root;
    private EditText endpoint, auth;
    private TextView status;
    private Button connect, forget;
    private WebView web;
    private CockpitFrame cockpit;
    private Connection connection;
    private boolean failed;
    private ValueCallback<Uri[]> fileCallback;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        prefs = getSharedPreferences("connection", MODE_PRIVATE);
        showLauncher();
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private LinearLayout column() { LinearLayout v = new LinearLayout(this); v.setOrientation(LinearLayout.VERTICAL); return v; }
    private void setRoot() {
        root = column(); root.setBackgroundColor(NAVY);
        root.setFitsSystemWindows(true);
        if (android.os.Build.VERSION.SDK_INT >= 30) root.setOnApplyWindowInsetsListener((view, insets) -> {
            android.graphics.Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
            view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return WindowInsets.CONSUMED;
        });
        setContentView(root);
    }

    private TextView text(String value, int size) {
        TextView view = new TextView(this); view.setText(value); view.setTextSize(size);
        view.setTextColor(Color.LTGRAY); view.setPadding(0, dp(8), 0, dp(8)); return view;
    }
    private Button button(String value, Runnable action) {
        Button button = new Button(this); button.setText(value); button.setAllCaps(false);
        button.setTextColor(AMBER);
        button.setBackgroundTintList(android.content.res.ColorStateList.valueOf(Color.rgb(25, 35, 53)));
        button.setMinHeight(dp(48)); button.setOnClickListener(v -> action.run()); return button;
    }
    private EditText input(String placeholder, String description) {
        EditText field = new EditText(this); field.setHint(placeholder); field.setContentDescription(description);
        field.setTextSize(16); field.setSingleLine(true);
        field.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        field.setMinHeight(dp(52)); field.setSelectAllOnFocus(false); return field;
    }
    private Connection saved() {
        try { return new Connection(prefs.getString("endpoint", ""), prefs.getString("auth", "")); }
        catch (IllegalArgumentException ignored) { return null; }
    }

    private void showLauncher() {
        disposeWeb(); connection = null; setRoot();
        ScrollView scroll = new ScrollView(this);
        LinearLayout form = column(); form.setPadding(dp(24), dp(28), dp(24), dp(24));
        scroll.addView(form); root.addView(scroll);
        ImageView mark = new ImageView(this); mark.setImageResource(tools.hearsay.cezarion.R.drawable.ic_launcher);
        mark.setScaleType(ImageView.ScaleType.FIT_CENTER); form.addView(mark, new LinearLayout.LayoutParams(-1, dp(76)));
        TextView title = text("Cezarion", 20); title.setTextColor(AMBER); form.addView(title);
        TextView heading = text("Your agents.\nIn your pocket.", 30); heading.setTypeface(null, Typeface.BOLD); heading.setTextColor(Color.WHITE); form.addView(heading);
        form.addView(text("Connect to your Cezarion server to follow tasks and keep work moving.", 16));
        form.addView(text("Cockpit address", 14));
        endpoint = input("https://cezar.example.com", "Cockpit address"); form.addView(endpoint);
        form.addView(text("Trusted sign-in origin · optional", 14));
        auth = input("https://auth.example.com", "Trusted sign-in origin"); form.addView(auth);
        form.addView(text("If your server redirects to a separate sign-in service, enter its HTTPS origin here.", 13));
        connect = button("Connect", this::connect); connect.setTextColor(Color.BLACK); connect.setBackgroundTintList(android.content.res.ColorStateList.valueOf(AMBER)); form.addView(connect);
        status = text("", 14); status.setTextColor(AMBER); status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE); form.addView(status);
        form.addView(text("Your address and website sign-in are remembered on this device. Agents keep running on your server when you close the app.", 13));
        forget = button("Forget connection & sign out", () -> new AlertDialog.Builder(this)
            .setTitle("Forget this connection?").setMessage("This clears the saved address, cookies, and website data from this app.")
            .setNegativeButton("Cancel", null).setPositiveButton("Forget", (dialog, which) -> {
                busy(true); clearSession(() -> { prefs.edit().clear().apply(); showLauncher(); status.setText("Connection and sign-in cleared."); });
            }).show()); form.addView(forget);
        Connection saved = saved();
        if (saved != null) { endpoint.setText(saved.endpoint); auth.setText(saved.signInOrigin); }
    }

    private void busy(boolean value) { connect.setEnabled(!value); forget.setEnabled(!value); }
    private void connect() {
        try {
            Connection selected = new Connection(endpoint.getText().toString(), auth.getText().toString());
            ((android.view.inputmethod.InputMethodManager)getSystemService(INPUT_METHOD_SERVICE)).hideSoftInputFromWindow(endpoint.getWindowToken(), 0);
            Runnable open = () -> {
                prefs.edit().putString("endpoint", selected.endpoint).putString("auth", selected.signInOrigin).apply();
                openCockpit(selected);
            };
            if (!selected.equals(saved())) { busy(true); clearSession(open); } else open.run();
        } catch (IllegalArgumentException error) { status.setText(error.getMessage()); }
    }

    private void clearSession(Runnable done) {
        disposeWeb();
        // A single app-wide browser profile. Clear it before changing either trusted origin.
        WebView cleaner = new WebView(this); cleaner.clearCache(true); cleaner.clearHistory();
        WebStorage.getInstance().deleteAllData();
        CookieManager.getInstance().removeAllCookies(removed -> {
            CookieManager.getInstance().flush(); cleaner.destroy(); done.run();
        });
    }

    private void openCockpit(Connection selected) {
        connection = selected; failed = false; setRoot();
        status = text("", 13); status.setTextColor(AMBER); status.setVisibility(View.GONE); root.addView(status);
        web = new WebView(this);
        web.setContentDescription("Cockpit");
        cockpit = new CockpitFrame(this, web, this::refresh, this::showControls);
        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true); settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false); settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSupportMultipleWindows(true);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, false);
        // Deliberately no addJavascriptInterface: the server gets no native capabilities.
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String target = request.getUrl().toString();
                if (selected.allows(target)) return false;
                if (request.isForMainFrame() && request.hasGesture() && Connection.safeOrigin(target) != null) external(target);
                else if (request.isForMainFrame()) blocked(target);
                return true;
            }
            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                if (web != view || cockpit == null) return;
                if (!selected.allows(url)) { view.stopLoading(); blocked(url); return; }
                status.setVisibility(View.GONE); cockpit.loading(true); failed = false;
            }
            @Override public void onPageFinished(WebView view, String url) { if (web == view && cockpit != null) cockpit.loading(false); CookieManager.getInstance().flush(); }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) { failed = true; showError("Could not connect. Check your network or VPN, then choose Refresh in ⋯."); }
            }
            @Override public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
                if (request.isForMainFrame() && response.getStatusCode() >= 500) { failed = true; showError("The server is unavailable. Choose Refresh in ⋯ to retry."); }
            }
            @Override public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                handler.cancel(); failed = true; showError("The server certificate could not be verified. Check your server's HTTPS setup.");
            }
            @Override public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                showLauncher(); status.setText("The page was suspended. Tap Connect to reopen it."); return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message message) {
                if (!isUserGesture) return false;
                WebView popup = new WebView(MainActivity.this);
                popup.setWebViewClient(new WebViewClient() {
                    @Override public boolean shouldOverrideUrlLoading(WebView child, WebResourceRequest request) {
                        String target = request.getUrl().toString();
                        if (selected.allows(target)) web.loadUrl(target); else external(target);
                        child.destroy(); return true;
                    }
                });
                ((WebView.WebViewTransport)message.obj).setWebView(popup); message.sendToTarget(); return true;
            }
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
                pick.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                try { startActivityForResult(pick, 10); }
                catch (android.content.ActivityNotFoundException e) { fileCallback.onReceiveValue(null); fileCallback = null; }
                return true;
            }
        });
        root.addView(cockpit, new LinearLayout.LayoutParams(-1, 0, 1));
        web.loadUrl(selected.endpoint);
    }

    private void showControls(View anchor) {
        if (web == null) return;
        PopupMenu menu = new PopupMenu(this, anchor);
        String currentOrigin = Connection.safeOrigin(web.getUrl());
        menu.getMenu().add(currentOrigin == null ? Connection.safeOrigin(connection.endpoint) : currentOrigin).setEnabled(false);
        menu.getMenu().add("Back").setEnabled(web.canGoBack()).setOnMenuItemClickListener(item -> { web.goBack(); return true; });
        menu.getMenu().add("Refresh").setOnMenuItemClickListener(item -> { refresh(); return true; });
        menu.getMenu().add("Connection settings").setOnMenuItemClickListener(item -> { showLauncher(); return true; });
        menu.show();
    }

    private void blocked(String url) {
        String host = Connection.safeOrigin(url);
        failed = true;
        showError("Blocked navigation to " + (host == null ? "an unsupported address" : host) + ". Check ⋯ → Connection settings.");
    }
    private void showError(String message) { if (cockpit != null) cockpit.loading(false); status.setText(message); status.setVisibility(View.VISIBLE); }
    private void external(String target) {
        String host = Connection.safeOrigin(target); if (host == null) { blocked(target); return; }
        new AlertDialog.Builder(this).setTitle("Open in browser?").setMessage(host)
            .setNegativeButton("Cancel", null).setPositiveButton("Open", (dialog, which) -> {
                try { startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(target)).addCategory(Intent.CATEGORY_BROWSABLE)); }
                catch (android.content.ActivityNotFoundException e) { showError("No browser is available to open this link."); }
            }).show();
    }
    private void reload() { if (web != null) { failed = false; status.setVisibility(View.GONE); web.loadUrl(connection.endpoint); } }
    private void refresh() {
        if (web == null) return;
        if (!failed && Connection.safeOrigin(connection.endpoint).equals(Connection.safeOrigin(web.getUrl()))) web.reload();
        else reload();
    }
    private void disposeWeb() {
        if (fileCallback != null) { fileCallback.onReceiveValue(null); fileCallback = null; }
        if (web != null) {
            web.stopLoading(); web.setWebChromeClient(null); web.setWebViewClient(new WebViewClient());
            if (web.getParent() instanceof android.view.ViewGroup parent) parent.removeView(web);
            web.destroy(); web = null;
        }
        cockpit = null;
    }
    @Override public void onBackPressed() { if (web != null && web.canGoBack()) web.goBack(); else if (web != null) showLauncher(); else super.onBackPressed(); }
    @Override protected void onPause() { if (web != null) { web.onPause(); CookieManager.getInstance().flush(); } super.onPause(); }
    @Override protected void onResume() { super.onResume(); if (web != null) { web.onResume(); if (failed) reload(); } }
    @Override protected void onDestroy() { disposeWeb(); super.onDestroy(); }
    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == 10 && fileCallback != null) {
            fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result, data)); fileCallback = null;
        }
    }
}

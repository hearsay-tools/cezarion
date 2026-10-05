package tools.hearsay.cezarion;

import android.content.Context;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.webkit.WebView;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

/** Overlay controls reserve no viewport space and never intercept the page's scroll. */
final class CockpitFrame extends FrameLayout {
    private final WebView web;
    private final Runnable refresh;
    private final TextView hint;
    private final ProgressBar progress;
    private final Button controls;
    private float startX, startY;
    private boolean pull;
    private float dragY, originalOffset;
    private boolean dragging;

    CockpitFrame(Context context, WebView web, Runnable refresh, View.OnClickListener menu) {
        super(context);
        this.web = web; this.refresh = refresh;
        addView(web, new LayoutParams(-1, -1));
        controls = new Button(context);
        controls.setText("⋯"); controls.setTextSize(26); controls.setTextColor(Color.WHITE);
        controls.setPadding(0, 0, 0, 0); controls.setMinWidth(0); controls.setMinHeight(0);
        controls.setContentDescription("Browser controls");
        controls.setTooltipText("Back, refresh and connection settings. Drag to move.");
        GradientDrawable background = new GradientDrawable();
        background.setColor(Color.argb(220, 38, 38, 38)); background.setCornerRadius(dp(24));
        controls.setBackground(background);
        LayoutParams placement = new LayoutParams(dp(48), dp(48), Gravity.RIGHT | Gravity.CENTER_VERTICAL);
        placement.rightMargin = dp(6);
        addView(controls, placement);
        controls.setOnClickListener(menu);
        controls.setOnTouchListener((v, event) -> {
            switch (event.getActionMasked()) {
                case MotionEvent.ACTION_DOWN -> { dragY = event.getRawY(); originalOffset = v.getTranslationY(); dragging = false; }
                case MotionEvent.ACTION_MOVE -> {
                    float delta = event.getRawY() - dragY;
                    if (Math.abs(delta) > dp(8)) dragging = true;
                    if (dragging) v.setTranslationY(clamp(originalOffset + delta));
                }
                case MotionEvent.ACTION_UP -> { if (!dragging) v.performClick(); }
            }
            return true;
        });
        addOnLayoutChangeListener((v, l, t, r, b, oldL, oldT, oldR, oldB) -> controls.setTranslationY(clamp(controls.getTranslationY())));
        hint = new TextView(context); hint.setTextColor(Color.WHITE); hint.setBackgroundColor(Color.rgb(38, 38, 38));
        hint.setPadding(dp(12), dp(6), dp(12), dp(6)); hint.setVisibility(GONE);
        LayoutParams hintPlacement = new LayoutParams(-2, -2, Gravity.TOP | Gravity.CENTER_HORIZONTAL); hintPlacement.topMargin = dp(12);
        addView(hint, hintPlacement);
        progress = new ProgressBar(context); progress.setContentDescription("Loading cockpit"); progress.setVisibility(GONE);
        LayoutParams progressPlacement = new LayoutParams(dp(28), dp(28), Gravity.TOP | Gravity.CENTER_HORIZONTAL); progressPlacement.topMargin = dp(12);
        addView(progress, progressPlacement);
    }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private float clamp(float offset) { float limit = Math.max(0, getHeight() / 2f - dp(28)); return Math.max(-limit, Math.min(limit, offset)); }
    void loading(boolean active) { progress.setVisibility(active ? VISIBLE : GONE); hint.setVisibility(GONE); }

    @Override public boolean dispatchTouchEvent(MotionEvent event) {
        float x = event.getX(), y = event.getY();
        switch (event.getActionMasked()) {
            case MotionEvent.ACTION_DOWN -> {
                startX = x; startY = y;
                // Nested cockpit panels deliberately contain their own overscroll.
                // Only a pull from the top edge may refresh; normal thread scrolling cannot.
                boolean onControls = x >= controls.getLeft() && x <= controls.getRight()
                    && y >= controls.getTop() + controls.getTranslationY() && y <= controls.getBottom() + controls.getTranslationY();
                pull = !onControls && y <= dp(48) && x > dp(28) && x < getWidth() - dp(28) && !web.canScrollVertically(-1);
            }
            case MotionEvent.ACTION_POINTER_DOWN, MotionEvent.ACTION_CANCEL -> { pull = false; hint.setVisibility(GONE); }
            case MotionEvent.ACTION_MOVE -> {
                float dy = y - startY, dx = Math.abs(x - startX);
                if (dx > dp(40) || dy < -dp(16)) pull = false;
                boolean show = pull && dy > dp(20) && dy > dx * 2 && progress.getVisibility() != VISIBLE;
                hint.setText(dy >= dp(100) ? "Release to refresh" : "Pull to refresh");
                hint.setVisibility(show ? VISIBLE : GONE);
            }
        }
        boolean result = super.dispatchTouchEvent(event);
        if (event.getActionMasked() == MotionEvent.ACTION_UP) {
            hint.setVisibility(GONE);
            if (pull && y - startY >= dp(100) && y - startY > Math.abs(x - startX) * 2) refresh.run();
            pull = false;
        }
        return result;
    }
}

// Browser-only fixture: prevent live server WebSocket health from overwriting mocked HTTP health.
window.WebSocket=class extends EventTarget{static CONNECTING=0;static OPEN=1;static CLOSING=2;static CLOSED=3;readyState=3;constructor(){super()}send(){}close(){}};
